import * as fs from 'fs';
import * as path from 'path';
import { ANTENNA_CATALOG } from '../../../domain/rf/antenna-catalog';

// Static wiring guard for the antenna catalogue and the sector-pointing
// controls, in the same style as ims-natping-wiring.test.ts.
//
// Three regressions are pinned here, because each one is silent:
//
//   * The catalogue getting a second, divergent copy in the frontend. The
//     numbers are only worth anything if the figure shown in the inspector is
//     the figure the engine simulated with — a duplicated list drifts on the
//     first edit and nothing fails.
//
//   * The azimuth sweep going back to a 0-359 slider. That dead-ends at 0:
//     a sector pointing north cannot be rotated counter-clockwise at all,
//     which reads as a broken control rather than a range limit.
//
//   * The map drawing only the 3 dB wedge again. A standard 3 x 65 deg site on
//     120 deg spacing then shows 55 deg of apparent emptiness between sectors
//     that the engine does not actually have (the -10 dB contours nearly
//     touch, and the heatmap is continuous across the seam) -- so the picture
//     contradicts the simulation and invites someone to "fix" the spacing.

const BACKEND_SRC = path.resolve(__dirname, '../../..');
const FRONTEND_SRC = path.resolve(__dirname, '../../../../../frontend/src');

const CONTROLLER = fs.readFileSync(path.join(BACKEND_SRC, 'interfaces/rest/rf-simulation-controller.ts'), 'utf-8');
const API = fs.readFileSync(path.join(FRONTEND_SRC, 'api/rfSimulation.ts'), 'utf-8');
const EDITOR = fs.readFileSync(path.join(FRONTEND_SRC, 'components/rfplanning/RadioEditor.tsx'), 'utf-8');
const MAP = fs.readFileSync(path.join(FRONTEND_SRC, 'components/rfplanning/PlanningMap.tsx'), 'utf-8');

describe('antenna catalogue wiring', () => {
  it('is served by the controller', () => {
    expect(CONTROLLER).toMatch(/router\.get\('\/antennas'/);
    expect(CONTROLLER).toMatch(/ANTENNA_CATALOG/);
  });

  it('is fetched by the frontend rather than redefined there', () => {
    expect(API).toMatch(/get<\{[^}]*antennas: AntennaModel\[\][^}]*\}>\('\/antennas'\)/s);
    // A second copy of the data would show up as entries, not just the type.
    for (const antenna of ANTENNA_CATALOG) {
      if (antenna.generic) continue;
      expect(API).not.toContain(antenna.model);
      expect(EDITOR).not.toContain(antenna.model);
    }
  });

  it('carries the pattern fields an antenna owns all the way to the engine', () => {
    for (const field of ['verticalBeamwidthDeg', 'frontToBackDb', 'electricalDowntiltDeg']) {
      expect(CONTROLLER).toContain(field);
      expect(API).toContain(field);
    }
  });

  it('adds electrical downtilt to mechanical rather than dropping one of them', () => {
    expect(CONTROLLER).toMatch(
      /mechanicalDowntiltDeg:\s*\n?\s*num\(cell\.mechanicalDowntiltDeg[^)]*\) \+\s*\n?\s*num\(cell\.electricalDowntiltDeg/,
    );
  });

  it('applies a whole antenna at once, never a partial pattern', () => {
    // Gain and both beamwidths are tied by the aperture, so a selection that
    // set only some of them would describe an antenna nobody makes.
    const applyBlock = /export function applyAntenna[\s\S]*?\n}/.exec(API)?.[0] ?? '';
    expect(applyBlock).toContain('beamWidthDeg');
    expect(applyBlock).toContain('verticalBeamwidthDeg');
    expect(applyBlock).toContain('txAntennaGainDbi');
    expect(applyBlock).toContain('frontToBackDb');
  });

  it('gives every site layout a real default antenna', () => {
    const ids = ANTENNA_CATALOG.map(a => a.id);
    const defaults = [...API.matchAll(/defaultAntennaId: '([^']+)'/g)].map(m => m[1]);
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    for (const id of defaults) expect(ids).toContain(id);
  });
});

describe('azimuth sweep', () => {
  it('lets the slider go negative so a panel rotates both ways', () => {
    expect(EDITOR).toMatch(/type="range" min="-180" max="180"/);
    // The regression: a slider that cannot be dragged below due north.
    expect(EDITOR).not.toMatch(/type="range" min="0" max="359"/);
  });

  it('normalises instead of clamping, so rotation wraps past north', () => {
    expect(API).toMatch(/export function normalizeAzimuthDeg/);
    expect(API).toMatch(/\(\(Math\.round\(deg\) % 360\) \+ 360\) % 360/);
    expect(EDITOR).toContain('normalizeAzimuthDeg');
  });

  it('offers wrapping rotate controls either side of the slider', () => {
    expect(EDITOR).toMatch(/rotate\(-ROTATE_STEP_DEG\)/);
    expect(EDITOR).toMatch(/rotate\(ROTATE_STEP_DEG\)/);
    // Both need an accessible name; they are icon-only.
    expect(EDITOR).toMatch(/aria-label=\{`Rotate \$\{radio\.name\} \$\{ROTATE_STEP_DEG\}° counter-clockwise`\}/);
    expect(EDITOR).toMatch(/aria-label=\{`Rotate \$\{radio\.name\} \$\{ROTATE_STEP_DEG\}° clockwise`\}/);
  });

  it('no longer caps the typed azimuth at 359, which blocked typing a negative', () => {
    expect(EDITOR).not.toMatch(/id=\{id\('az'\)\} type="number" step="5" min="0" max="359"/);
  });
});

describe('sector wedge rendering', () => {
  it('draws the pattern tail as well as the rated beam', () => {
    expect(MAP).toContain('OUTER_CONTOUR_DB');
    expect(MAP).toMatch(/patternWidthDeg\(radio\.beamWidthDeg, OUTER_CONTOUR_DB\)/);
  });

  it('keeps the tail out of the click path', () => {
    // It overlaps its neighbours by design, so taking clicks would make
    // selecting the intended sector ambiguous exactly at the seam.
    const tail = /L\.polygon\(sectorWedge\(radio, radiusM, patternWidthDeg[\s\S]*?\)\.addTo\(group\);/.exec(MAP)?.[0] ?? '';
    expect(tail).toContain('interactive: false');
    expect(tail).toContain('stroke: false');
  });

  it('inverts the same roll-off the engine uses', () => {
    expect(MAP).toMatch(/Math\.min\(360, 2 \* beamWidthDeg \* Math\.sqrt\(dropDb \/ 12\)\)/);
  });
});
