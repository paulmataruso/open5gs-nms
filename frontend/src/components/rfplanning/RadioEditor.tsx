import { useState } from 'react';
import {
  ChevronDown, ChevronRight, Trash2, Copy, Lock, Unlock, ArrowUpLeft,
  RotateCcw, RotateCw, AlertTriangle, ExternalLink,
} from 'lucide-react';
import {
  CUSTOM_ANTENNA_ID, applyAntenna, normalizeAzimuthDeg, signedAzimuthDeg,
  type AntennaModel, type PlanningRadio,
} from '../../api/rfSimulation';

// Sector-level inspector.
//
// Only what belongs to ONE panel: which antenna it is, where it points, how
// much power goes into it. Position, height, channel and technology are
// properties of the mast and live on SiteEditor, so they cannot drift between
// sectors of the same site.
//
// Antenna comes first because it is the single most consequential field here:
// it sets gain and both beamwidths and the front-to-back ratio together, and
// those four are tied by the aperture. Picking a real panel is both less work
// and more correct than typing four numbers that may not describe anything
// buildable.
//
// The three pointing fields below it are always visible; the rest sits behind
// a collapsed group. Someone dropping a site and pressing Simulate never has
// to open it.

interface Props {
  radio: PlanningRadio;
  siteName: string;
  sectorCount: number;
  antennas: AntennaModel[];
  defaultFrontToBackDb: number;
  onChange: (patch: Partial<PlanningRadio>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onSelectSite: () => void;
}

/** How far one press of a rotate arrow turns the panel. */
const ROTATE_STEP_DEG = 5;

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

function Group(props: { title: string; description: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-nms-border rounded-md">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {open ? <ChevronDown className="w-4 h-4 shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 shrink-0" aria-hidden="true" />}
        <span className="text-xs font-medium flex-1">{props.title}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <p className="text-xs text-nms-text-dim">{props.description}</p>
          {props.children}
        </div>
      )}
    </div>
  );
}

export function RadioEditor({
  radio, siteName, sectorCount, antennas, defaultFrontToBackDb,
  onChange, onDelete, onDuplicate, onSelectSite,
}: Props) {
  const numeric = (key: keyof PlanningRadio) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) onChange({ [key]: value } as Partial<PlanningRadio>);
  };
  const id = (suffix: string) => `radio-${radio.id}-${suffix}`;

  // Azimuth keeps a text buffer while it is being typed, so a partially typed
  // negative ("-" then "-1" then "-10") survives long enough to finish. The
  // committed value is always a normalised bearing; the buffer only governs
  // what the box shows until focus leaves.
  const [azText, setAzText] = useState<string | null>(null);

  const selected = antennas.find(a => a.id === radio.antennaModelId);
  const isCustom = radio.antennaModelId === CUSTOM_ANTENNA_ID;
  const vendors = Array.from(new Set(antennas.map(a => a.vendor)));

  /**
   * Editing a pattern field by hand detaches the sector from its catalogue
   * entry. Without this the inspector would go on naming a specific panel
   * while describing a pattern that panel does not have — the worst of both,
   * since the label is what an operator would quote when ordering.
   */
  const patchPattern = (patch: Partial<PlanningRadio>) => {
    onChange(selected && !selected.generic ? { ...patch, antennaModelId: CUSTOM_ANTENNA_ID } : patch);
  };
  const patternNumeric = (key: keyof PlanningRadio) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value)) patchPattern({ [key]: value } as Partial<PlanningRadio>);
  };

  const rotate = (delta: number) => onChange({ azimuthDeg: normalizeAzimuthDeg(radio.azimuthDeg + delta) });
  const signed = signedAzimuthDeg(radio.azimuthDeg);

  const sectorMhz = radio.frequencyGhz * 1000;
  const bandMismatch = selected && selected.freqMaxMhz > 0 && selected.freqMaxMhz < 100000 &&
    (sectorMhz < selected.freqMinMhz || sectorMhz > selected.freqMaxMhz)
    ? `${selected.vendor} ${selected.model} is specified for ${selected.freqMinMhz}–${selected.freqMaxMhz} MHz, ` +
      `but this sector is on ${Math.round(sectorMhz)} MHz. Its published gain and pattern do not apply there.`
    : null;

  const effectiveFrontToBack = radio.frontToBackDb ?? defaultFrontToBackDb;
  const totalTiltDeg = radio.mechanicalDowntiltDeg + (radio.electricalDowntiltDeg ?? 0);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onSelectSite}
        className="flex items-center gap-1.5 text-xs text-nms-text-dim hover:text-nms-text"
      >
        <ArrowUpLeft className="w-3.5 h-3.5" aria-hidden="true" />
        {siteName} · {sectorCount} sector{sectorCount === 1 ? '' : 's'}
      </button>

      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <label htmlFor={id('name')} className="sr-only">Sector name</label>
          <input
            id={id('name')}
            className="nms-input w-full font-medium"
            value={radio.name}
            onChange={e => onChange({ name: e.target.value })}
            placeholder="Sector name"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Sector actions">
          <button
            type="button" onClick={() => onChange({ locked: !radio.locked })}
            className="nms-btn-ghost p-1.5 border border-nms-border"
            aria-label={radio.locked ? `Unlock ${radio.name} azimuth for optimisation` : `Lock ${radio.name} azimuth during optimisation`}
            title={radio.locked ? 'Azimuth locked — optimisation will not move it' : 'Azimuth free — optimisation may change it'}
          >
            {radio.locked
              ? <Lock className="w-3.5 h-3.5 text-nms-amber" aria-hidden="true" />
              : <Unlock className="w-3.5 h-3.5" aria-hidden="true" />}
          </button>
          <button type="button" onClick={onDuplicate} className="nms-btn-ghost p-1.5 border border-nms-border" aria-label={`Duplicate sector ${radio.name}`}>
            <Copy className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={onDelete} className="nms-btn-ghost p-1.5 border border-nms-border" aria-label={`Delete sector ${radio.name}`}>
            <Trash2 className="w-3.5 h-3.5 text-nms-red" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ── Antenna ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <label htmlFor={id('antenna')} className="text-xs text-nms-text-dim">Antenna</label>
        <select
          id={id('antenna')}
          className="nms-input w-full"
          value={radio.antennaModelId ?? CUSTOM_ANTENNA_ID}
          onChange={e => {
            const value = e.target.value;
            if (value === CUSTOM_ANTENNA_ID) {
              // Seed custom entry with whatever is on the sector now, so
              // switching to Custom is a starting point rather than a reset.
              onChange({
                antennaModelId: CUSTOM_ANTENNA_ID,
                verticalBeamwidthDeg: radio.verticalBeamwidthDeg ?? 9,
                frontToBackDb: effectiveFrontToBack,
                electricalDowntiltDeg: radio.electricalDowntiltDeg ?? 0,
              });
              return;
            }
            const antenna = antennas.find(a => a.id === value);
            if (antenna) onChange(applyAntenna(antenna));
          }}
        >
          {vendors.map(vendor => (
            <optgroup key={vendor} label={vendor}>
              {antennas.filter(a => a.vendor === vendor).map(a => (
                <option key={a.id} value={a.id}>{a.model}</option>
              ))}
            </optgroup>
          ))}
          <optgroup label="Custom">
            <option value={CUSTOM_ANTENNA_ID}>Custom — enter from a spec sheet</option>
          </optgroup>
        </select>

        {selected && (
          <div className="text-xs text-nms-text-dim space-y-0.5">
            <p>
              {selected.gainDbi} dBi · {selected.beamWidthDeg === 360 ? 'omni' : `${selected.beamWidthDeg}° H`}
              {' × '}{selected.verticalBeamwidthDeg}° V
              {' · '}{selected.frontToBackDb ? `${selected.frontToBackDb} dB F/B` : `${defaultFrontToBackDb} dB F/B (tool default)`}
              {' · '}{selected.ports} port{selected.ports === 1 ? '' : 's'} · {selected.polarization}
            </p>
            <p>{selected.bandLabel}</p>
            {selected.electricalDowntiltMaxDeg > selected.electricalDowntiltDeg && (
              <p>Electrical tilt adjustable {selected.electricalDowntiltDeg}–{selected.electricalDowntiltMaxDeg}° — set it below.</p>
            )}
            {selected.beamWidthDeg < 360 && (
              <p>
                −10 dB width {Math.round(selected.tenDbWidthDeg)}°, so three of these on 120° spacing
                cross over {selected.crossover3SectorDb} dB down.
              </p>
            )}
            {selected.verticalDerived && (
              <p className="opacity-80">
                Vertical beamwidth is not published for this panel — {selected.verticalBeamwidthDeg}° is derived
                from its gain and azimuth width, not measured.
              </p>
            )}
            {selected.notes && <p className="opacity-80">{selected.notes}</p>}
            {selected.source && (
              <a
                href={selected.source} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-nms-accent hover:underline"
              >
                Specification <ExternalLink className="w-3 h-3" aria-hidden="true" />
              </a>
            )}
          </div>
        )}

        {bandMismatch && (
          <p className="flex items-start gap-1.5 text-xs text-nms-amber">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
            {bandMismatch}
          </p>
        )}
      </div>

      {isCustom && (
        <div className="border border-nms-border rounded-md px-3 py-3 space-y-3">
          <p className="text-xs text-nms-text-dim">
            Straight off the spec sheet. Gain and the two beamwidths are not independent —
            a panel's gain is roughly 32400 / (H × V), so a combination far from that
            describes an antenna nobody makes.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gain" unit="dBi" htmlFor={id('cgain')}>
              <input
                id={id('cgain')} type="number" step="0.1" className="nms-input"
                value={radio.txAntennaGainDbi} onChange={numeric('txAntennaGainDbi')}
              />
            </Field>
            <Field label="Horizontal beamwidth" unit="°" htmlFor={id('chbw')} hint="360 for an omni">
              <input
                id={id('chbw')} type="number" step="1" min="5" max="360" className="nms-input"
                value={radio.beamWidthDeg} onChange={numeric('beamWidthDeg')}
              />
            </Field>
            <Field label="Vertical beamwidth" unit="°" htmlFor={id('cvbw')} hint="Sets how fast it falls off below the horizon">
              <input
                id={id('cvbw')} type="number" step="0.1" min="1" max="90" className="nms-input"
                value={radio.verticalBeamwidthDeg ?? 9} onChange={numeric('verticalBeamwidthDeg')}
              />
            </Field>
            <Field label="Front-to-back" unit="dB" htmlFor={id('cftb')} hint="At 180°; floors the back-lobe">
              <input
                id={id('cftb')} type="number" step="1" min="5" max="60" className="nms-input"
                value={effectiveFrontToBack} onChange={numeric('frontToBackDb')}
              />
            </Field>
          </div>
        </div>
      )}

      {/* The three that matter. Always visible, and the wedge on the map
          redraws as you change them. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Azimuth" unit="°" htmlFor={id('az')} hint="0 = north; negatives wrap (−10 → 350)">
          <input
            id={id('az')} type="number" step="5" className="nms-input"
            value={azText ?? radio.azimuthDeg}
            onChange={e => {
              setAzText(e.target.value);
              const value = Number(e.target.value);
              if (e.target.value.trim() !== '' && Number.isFinite(value)) {
                onChange({ azimuthDeg: normalizeAzimuthDeg(value) });
              }
            }}
            onBlur={() => setAzText(null)}
          />
        </Field>
        <Field label="Beamwidth" unit="°" htmlFor={id('bw')} hint="65 typical for 3-sector">
          <input
            id={id('bw')} type="number" step="5" min="5" max="360" className="nms-input"
            value={radio.beamWidthDeg} onChange={patternNumeric('beamWidthDeg')}
          />
        </Field>
        <Field label="Tx power" unit="dBm" htmlFor={id('tx')}>
          <input id={id('tx')} type="number" step="1" className="nms-input" value={radio.txPowerDbm} onChange={numeric('txPowerDbm')} />
        </Field>
        <Field
          label="Mechanical downtilt" unit="°" htmlFor={id('tilt')}
          hint={radio.electricalDowntiltDeg
            ? `+${radio.electricalDowntiltDeg}° electrical = ${totalTiltDeg}° total`
            : 'How the bracket is angled'}
        >
          <input id={id('tilt')} type="number" step="1" min="0" max="45" className="nms-input" value={radio.mechanicalDowntiltDeg} onChange={numeric('mechanicalDowntiltDeg')} />
        </Field>
      </div>

      {/* Azimuth is the field most worth dragging rather than typing. The
          slider is signed so north sits in the middle and the panel turns
          both ways from it; the arrows wrap, so rotation never dead-ends at
          an endpoint the way a plain 0–359 slider does at 0. */}
      <div className="flex flex-col gap-1">
        <label htmlFor={id('azrange')} className="text-xs text-nms-text-dim">
          Sweep azimuth — {radio.azimuthDeg}° ({signed >= 0 ? '+' : ''}{signed}° from north)
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button" onClick={() => rotate(-ROTATE_STEP_DEG)}
            className="nms-btn-ghost p-1.5 border border-nms-border shrink-0"
            aria-label={`Rotate ${radio.name} ${ROTATE_STEP_DEG}° counter-clockwise`}
            title={`Rotate ${ROTATE_STEP_DEG}° counter-clockwise (wraps past north)`}
          >
            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <input
            id={id('azrange')} type="range" min="-180" max="180" step="1"
            value={signed}
            onChange={e => {
              const value = Number(e.target.value);
              if (Number.isFinite(value)) onChange({ azimuthDeg: normalizeAzimuthDeg(value) });
            }}
            className="flex-1"
            aria-valuetext={`${radio.azimuthDeg} degrees`}
          />
          <button
            type="button" onClick={() => rotate(ROTATE_STEP_DEG)}
            className="nms-btn-ghost p-1.5 border border-nms-border shrink-0"
            aria-label={`Rotate ${radio.name} ${ROTATE_STEP_DEG}° clockwise`}
            title={`Rotate ${ROTATE_STEP_DEG}° clockwise (wraps past north)`}
          >
            <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
        <p className="text-xs text-nms-text-dim opacity-80">
          Negative is west of north, positive east. The arrows keep going past either end.
        </p>
      </div>

      <Group title="Antenna and receiver" description="Electrical tilt, receiver assumptions and load. Defaults suit a CBRS small cell.">
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="Electrical downtilt" unit="°" htmlFor={id('etilt')}
            hint={selected && selected.electricalDowntiltMaxDeg > selected.electricalDowntiltDeg
              ? `This panel allows ${selected.electricalDowntiltDeg}–${selected.electricalDowntiltMaxDeg}°`
              : 'Built into the panel; adds to the mechanical tilt'}
          >
            <input
              id={id('etilt')} type="number" step="1" min="0" max="20" className="nms-input"
              value={radio.electricalDowntiltDeg ?? 0} onChange={numeric('electricalDowntiltDeg')}
            />
          </Field>
          <Field label="Rx sensitivity" unit="dBm" htmlFor={id('sens')}>
            <input id={id('sens')} type="number" step="1" className="nms-input" value={radio.receiverSensitivityDbm} onChange={numeric('receiverSensitivityDbm')} />
          </Field>
          <Field label="Receiver height" unit="m" htmlFor={id('rh')}>
            <input id={id('rh')} type="number" step="0.5" min="0.5" className="nms-input" value={radio.receiverHeightM} onChange={numeric('receiverHeightM')} />
          </Field>
          <Field label="Load factor" htmlFor={id('load')} hint="0–1; scales how much this sector interferes">
            <input id={id('load')} type="number" step="0.05" min="0" max="1" className="nms-input" value={radio.loadFactor} onChange={numeric('loadFactor')} />
          </Field>
        </div>
      </Group>
    </div>
  );
}
