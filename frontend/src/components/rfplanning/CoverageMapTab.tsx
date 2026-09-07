import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import { Crosshair, Trash2, FolderOpen, Save, Plus, Scale, Radio as RadioIcon, RadioTower, Target, FileDown, Ungroup } from 'lucide-react';
import toast from 'react-hot-toast';
import { rfPlanningApi, rfPlanningProjectsApi } from '../../api/rfPlanning';
import type {
  CoverageGridInput, CoverageGridResult, CalculationResult, LatLon,
  PropagationModel, HataEnvironment, Cost231CityType, LogDistanceEnvironment, WalfischIkegamiMode,
  ItmRadioClimate, ItmPolarization, ItmVariabilityMode,
  RfPlanningProject, RfPlanningSite, SiteComparisonResult,
  InterferenceGridResult, CalibrationResult,
} from '../../api/rfPlanning';
import { NumField, SelectField, EquationDisclosure, AssumptionsWarnings, ResultLine, fixLeafletDefaultIcon } from './shared';

fixLeafletDefaultIcon();

const EARTH_RADIUS_M = 6_371_008.8;

function destinationPoint(lat: number, lon: number, bearingDeg: number, distanceM: number): LatLon {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = (bearingDeg * Math.PI) / 180;
  const phi1 = (lat * Math.PI) / 180;
  const lambda1 = (lon * Math.PI) / 180;
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
  );
  return { lat: (phi2 * 180) / Math.PI, lon: (((lambda2 * 180) / Math.PI + 540) % 360) - 180 };
}

function boresightCone(lat: number, lon: number, azimuthDeg: number, beamwidthDeg: number, radiusM: number): [number, number][] {
  const halfBw = beamwidthDeg / 2;
  const steps = 12;
  const arcPoints: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const bearing = azimuthDeg - halfBw + (i / steps) * beamwidthDeg;
    const p = destinationPoint(lat, lon, bearing, radiusM);
    arcPoints.push([p.lat, p.lon]);
  }
  return [[lat, lon], ...arcPoints, [lat, lon]];
}

// The one draggable marker on this map is always "the currently selected
// radio" — whatever site loadSite() last loaded (or a fresh, not-yet-saved
// draft position if none has been loaded yet). It used to just be Leaflet's
// plain default blue pin, visually identical to itself at all times, which
// gave no feedback that a click had actually landed and selected anything
// — especially confusing for a 3-sector tower, where all 3 radios share one
// exact lat/lon and a plain pin sitting there looks the same regardless of
// which sector is actually loaded. This gold halo icon is deliberately
// unmistakable and only ever used for this one marker (other saved sites
// render as small purple dots — see the "other saved sites" effect) so
// "which one is selected and draggable right now" is answered by looking
// at the map, not by remembering a previous click.
const ACTIVE_SITE_ICON = L.divIcon({
  className: '',
  html: '<div style="width:20px;height:20px;border-radius:9999px;background:#facc15;border:3px solid #ffffff;box-shadow:0 0 0 3px #b45309,0 1px 4px rgba(0,0,0,0.5);"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
});

// A real, explicit "delete this radio" affordance directly on the map
// (there previously wasn't one at all — only the site list's own "Remove"
// button) that also makes selection itself unambiguous: clicking a radio
// both loads it into the edit form *and* opens this popup confirming
// exactly which one you clicked, with its own delete action right there,
// rather than relying purely on click hit-testing being unambiguous.
function buildSitePopup(name: string, onDelete: () => void): HTMLElement {
  const container = document.createElement('div');
  container.style.cssText = 'display:flex;flex-direction:column;gap:6px;min-width:150px;font-size:12px;';

  const title = document.createElement('div');
  title.textContent = name;
  title.style.cssText = 'font-weight:600;';
  container.appendChild(title);

  const deleteBtn = document.createElement('button');
  deleteBtn.textContent = 'Delete This Radio';
  deleteBtn.style.cssText = 'padding:4px 8px;border-radius:4px;border:1px solid #ef4444;background:transparent;color:#ef4444;cursor:pointer;font-size:11px;';
  deleteBtn.onclick = onDelete;
  container.appendChild(deleteBtn);

  return container;
}

// Display convention, not a spec-sourced number — commonly used
// LTE-signal-strength buckets for a quick visual read of the heatmap.
function dbmToColor(dbm: number): string {
  if (dbm >= -80) return '#22c55e';
  if (dbm >= -95) return '#eab308';
  if (dbm >= -105) return '#f97316';
  return '#ef4444';
}

const LEGEND: { label: string; range: string; color: string }[] = [
  { label: 'Strong',   range: '≥ -80 dBm',        color: '#22c55e' },
  { label: 'Good',     range: '-80 to -95 dBm',   color: '#eab308' },
  { label: 'Marginal', range: '-95 to -105 dBm',  color: '#f97316' },
  { label: 'Poor',     range: '< -105 dBm',       color: '#ef4444' },
];

// Display convention for SINR, not a spec-sourced number.
function sinrToColor(sinrDb: number): string {
  if (sinrDb >= 20) return '#22c55e';
  if (sinrDb >= 10) return '#84cc16';
  if (sinrDb >= 0) return '#f97316';
  return '#ef4444';
}

const SINR_LEGEND: { label: string; range: string; color: string }[] = [
  { label: 'Excellent', range: '≥ 20 dB',      color: '#22c55e' },
  { label: 'Good',      range: '10 to 20 dB',  color: '#84cc16' },
  { label: 'Fair',      range: '0 to 10 dB',   color: '#f97316' },
  { label: 'Poor',      range: '< 0 dB',       color: '#ef4444' },
];

const SECTOR_LABELS = ['Alpha', 'Beta', 'Gamma'];

// Everything else about a new tower (height, TX power, antenna gain, losses,
// propagation model...) is inherited from whatever's already in the main
// form — the user set those up before clicking Quick Add. Only the things
// that are specifically ABOUT being a multi-sector tower (how far apart the
// sectors point, and how wide each one's beam is) get asked here, since a
// real tower isn't always an even 120° split (terrain/interference planning
// can call for uneven spacing) and reusing whatever single-sector beamwidth
// happened to be in the form was a silent, easy-to-miss assumption.
function QuickAdd3SectorModal({ defaultBeamwidthDeg, onClose, onConfirm }: {
  defaultBeamwidthDeg: string;
  onClose: () => void;
  onConfirm: (opts: { name: string; startAzimuthDeg: number; spacingDeg: number; beamwidthDeg: number }) => void;
}) {
  const [name, setName] = useState('Tower');
  const [startAzimuthDeg, setStartAzimuthDeg] = useState('0');
  const [spacingDeg, setSpacingDeg] = useState('120');
  const [beamwidthDeg, setBeamwidthDeg] = useState(defaultBeamwidthDeg);

  const start = Number(startAzimuthDeg), spacing = Number(spacingDeg), beamwidth = Number(beamwidthDeg);
  const valid = name.trim().length > 0 && Number.isFinite(start) && Number.isFinite(spacing) && spacing > 0 && Number.isFinite(beamwidth) && beamwidth > 0;
  const previewAzimuths = valid ? [0, 1, 2].map(i => Math.round(((start + i * spacing) % 360 + 360) % 360)) : [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-nms-surface border border-nms-border rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl space-y-4">
        <h2 className="text-base font-semibold text-nms-text">Quick Add 3-Sector Site</h2>
        <p className="text-xs text-nms-text-dim -mt-2">
          Creates 3 radios at the current map location/height/radio settings, differing only in azimuth and beamwidth.
        </p>
        <div className="space-y-3">
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">Tower / site name</label>
            <input className="nms-input w-full" value={name} onChange={e => setName(e.target.value)} placeholder="Tower" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-nms-text-dim mb-1">Starting azimuth (°)</label>
              <input type="number" step="any" className="nms-input w-full" value={startAzimuthDeg} onChange={e => setStartAzimuthDeg(e.target.value)} />
            </div>
            <div>
              <label className="block text-xs text-nms-text-dim mb-1">Spacing between sectors (°)</label>
              <input type="number" step="any" className="nms-input w-full" value={spacingDeg} onChange={e => setSpacingDeg(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="block text-xs text-nms-text-dim mb-1">Horizontal beamwidth per sector (°)</label>
            <input type="number" step="any" className="nms-input w-full" value={beamwidthDeg} onChange={e => setBeamwidthDeg(e.target.value)} />
          </div>
          <p className="text-[11px] text-nms-text-dim">
            {valid
              ? `Sectors will point at ${previewAzimuths.map(a => `${a}°`).join(' / ')} (${SECTOR_LABELS.join('/')}), ${beamwidth}° wide each.`
              : 'Enter a name, a positive spacing, and a positive beamwidth.'}
          </p>
        </div>
        <div className="flex gap-3 pt-1">
          <button type="button" onClick={onClose} className="flex-1 nms-btn-ghost text-sm py-2">Cancel</button>
          <button
            type="button"
            disabled={!valid}
            onClick={() => onConfirm({ name: name.trim(), startAzimuthDeg: start, spacingDeg: spacing, beamwidthDeg: beamwidth })}
            className="flex-1 nms-btn-primary text-sm py-2 disabled:opacity-50"
          >
            Add 3-Sector Site
          </button>
        </div>
      </div>
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Output pixels per source grid cell, per axis — a fixed, modest supersampling
// factor so the smoothed overlay looks visibly continuous without an
// excessive canvas size.
const SMOOTH_UPSCALE = 6;
const SMOOTH_MAX_DIMENSION_PX = 1024;

// Bilinear interpolation (Wikipedia "Bilinear interpolation") — a plain,
// exact numerical method, nothing invented or fitted. The 4 corner values
// used at every output pixel are always real computed grid results; this
// only fills in a smooth gradient for display *between* them, matching how
// commercial RF tools (Atoll, iBwave) render coverage maps at a coarser
// sample grid than the display resolution. Cells the grid never computed
// (e.g. outside a circular radius, or skipped as out of a model's range)
// stay fully transparent rather than being papered over with a guessed
// value — a missing input is never silently interpolated into existence.
function buildSmoothOverlayDataUrl(
  cells: { row: number; col: number; value: number }[],
  rows: number, cols: number,
  colorForValue: (v: number) => string,
): string | null {
  if (rows < 2 || cols < 2) return null;
  const grid: (number | null)[][] = Array.from({ length: rows }, () => new Array(cols).fill(null));
  for (const c of cells) {
    if (c.row >= 0 && c.row < rows && c.col >= 0 && c.col < cols) grid[c.row][c.col] = c.value;
  }

  const outW = Math.min(cols * SMOOTH_UPSCALE, SMOOTH_MAX_DIMENSION_PX);
  const outH = Math.min(rows * SMOOTH_UPSCALE, SMOOTH_MAX_DIMENSION_PX);
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const imageData = ctx.createImageData(outW, outH);

  for (let py = 0; py < outH; py++) {
    const gy = (py / (outH - 1)) * (rows - 1);
    const row0 = Math.max(0, Math.min(rows - 2, Math.floor(gy)));
    const ty = gy - row0;
    for (let px = 0; px < outW; px++) {
      const gx = (px / (outW - 1)) * (cols - 1);
      const col0 = Math.max(0, Math.min(cols - 2, Math.floor(gx)));
      const tx = gx - col0;

      const q11 = grid[row0][col0];
      const q21 = grid[row0][col0 + 1];
      const q12 = grid[row0 + 1][col0];
      const q22 = grid[row0 + 1][col0 + 1];
      const idx = (py * outW + px) * 4;
      if (q11 == null || q21 == null || q12 == null || q22 == null) {
        imageData.data[idx + 3] = 0;
        continue;
      }
      const value = q11 * (1 - tx) * (1 - ty) + q21 * tx * (1 - ty) + q12 * (1 - tx) * ty + q22 * tx * ty;
      const [r, g, b] = hexToRgb(colorForValue(value));
      imageData.data[idx] = r;
      imageData.data[idx + 1] = g;
      imageData.data[idx + 2] = b;
      imageData.data[idx + 3] = Math.round(0.55 * 255); // matches the non-smoothed rectangles' fillOpacity
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

export function CoverageMapTab() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const siteMarkerRef = useRef<L.Marker | null>(null);
  const coneLayerRef = useRef<L.Polygon | null>(null);
  const heatmapGroupRef = useRef<L.LayerGroup | null>(null);
  const interferenceGroupRef = useRef<L.LayerGroup | null>(null);
  const drawnItemsRef = useRef<L.FeatureGroup | null>(null);
  const projectSitesGroupRef = useRef<L.LayerGroup | null>(null);
  const canvasRendererRef = useRef<L.Renderer | null>(null);
  const hasFitBoundsRef = useRef(false);

  const [site, setSite] = useState({ lat: '37.7749', lon: '-122.4194', heightM: '30' });
  const [antenna, setAntenna] = useState({
    azimuthDeg: '0', horizontalBeamwidthDeg: '65', verticalBeamwidthDeg: '',
    mechanicalDowntiltDeg: '2', electricalDowntiltDeg: '', frontToBackDb: '',
  });
  const [radio, setRadio] = useState({
    txPowerDbm: '40', cableLossDb: '2', connectorLossDb: '0.5', filterLossDb: '',
    antennaGainDbi: '17', frequencyMhz: '1900',
  });
  const [propagation, setPropagation] = useState({
    buildingLossDb: '', foliageLossDb: '', miscLossDb: '', ueAntennaGainDbi: '', receiverHeightM: '',
  });
  const [model, setModel] = useState<{
    propagationModel: PropagationModel; environment: HataEnvironment; cityType: Cost231CityType;
    autoDetectEnvironment: boolean;
    useTerrainData: boolean; isLineOfSight: boolean; pathLossExponent: string; logDistanceEnvironment: LogDistanceEnvironment;
    walfischIkegamiMode: WalfischIkegamiMode; buildingHeightM: string; streetWidthM: string;
    buildingSeparationM: string; streetOrientationDeg: string;
    radioClimate: ItmRadioClimate; polarization: ItmPolarization; modeOfVariability: ItmVariabilityMode;
    groundConductivity: string; groundPermittivity: string; surfaceRefractivityN0: string;
    timePercent: string; locationPercent: string; situationPercent: string;
  }>({
    propagationModel: 'fspl', environment: 'urban', cityType: 'medium', autoDetectEnvironment: false,
    useTerrainData: false, isLineOfSight: false, pathLossExponent: '', logDistanceEnvironment: 'urban',
    walfischIkegamiMode: 'nlos', buildingHeightM: '', streetWidthM: '', buildingSeparationM: '', streetOrientationDeg: '',
    radioClimate: 'continental-temperate', polarization: 'horizontal', modeOfVariability: 'broadcast',
    groundConductivity: '', groundPermittivity: '', surfaceRefractivityN0: '',
    timePercent: '', locationPercent: '', situationPercent: '',
  });
  const [grid, setGrid] = useState({ radiusM: '2000', resolution: '40', minAcceptableSignalDbm: '-100' });

  const [polygon, setPolygon] = useState<LatLon[]>([]);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<CalculationResult<CoverageGridResult> | null>(null);
  // Which saved site (if any) is currently loaded into the editable/
  // draggable marker — lets the "other sites" ghost layer exclude it, so
  // the exact same radio is never drawn twice (once as the real draggable
  // marker, again as an overlapping ghost underneath it). That overlap was
  // the actual root cause of clicks landing on the wrong thing.
  const [loadedSiteId, setLoadedSiteId] = useState<string | null>(null);
  const [show3SectorModal, setShow3SectorModal] = useState(false);

  const [projects, setProjects] = useState<RfPlanningProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [comparison, setComparison] = useState<SiteComparisonResult[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null;

  const [activeHeatmap, setActiveHeatmap] = useState<'coverage' | 'interference'>('coverage');
  const [interferenceResult, setInterferenceResult] = useState<CalculationResult<InterferenceGridResult> | null>(null);
  const [smoothHeatmap, setSmoothHeatmap] = useState(false);

  const [surveySiteId, setSurveySiteId] = useState('');
  const [surveyForm, setSurveyForm] = useState({ lat: '', lon: '', measuredDbm: '' });
  const [calibration, setCalibration] = useState<CalibrationResult | null>(null);
  const [loadingCalibration, setLoadingCalibration] = useState(false);

  const setSiteField = (k: keyof typeof site) => (v: string) => setSite(s => ({ ...s, [k]: v }));
  const setAntennaField = (k: keyof typeof antenna) => (v: string) => setAntenna(a => ({ ...a, [k]: v }));
  const setRadioField = (k: keyof typeof radio) => (v: string) => setRadio(r => ({ ...r, [k]: v }));
  const setPropagationField = (k: keyof typeof propagation) => (v: string) => setPropagation(p => ({ ...p, [k]: v }));
  const setGridField = (k: keyof typeof grid) => (v: string) => setGrid(g => ({ ...g, [k]: v }));

  useEffect(() => {
    rfPlanningProjectsApi.list().then(setProjects).catch(() => { /* projects are optional — a fresh install has none yet */ });
  }, []);

  // Map + draw-control setup — runs once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView(
      [Number(site.lat) || 0, Number(site.lon) || 0],
      13,
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const canvasRenderer = L.canvas({ padding: 0.5 });
    canvasRendererRef.current = canvasRenderer;

    const heatmapGroup = L.layerGroup().addTo(map);
    heatmapGroupRef.current = heatmapGroup;

    const interferenceGroup = L.layerGroup().addTo(map);
    interferenceGroupRef.current = interferenceGroup;

    const projectSitesGroup = L.layerGroup().addTo(map);
    projectSitesGroupRef.current = projectSitesGroup;

    const marker = L.marker([Number(site.lat) || 0, Number(site.lon) || 0], {
      draggable: true, icon: ACTIVE_SITE_ICON, zIndexOffset: 1000,
    }).addTo(map);
    // dragend is (re)bound in the "drag + delete popup" effect below, not
    // here — it needs the current loadedSiteId/activeProject to know
    // whether this radio belongs to a tower group and must drag its
    // sibling sectors along with it, and this mount-once effect only ever
    // sees their initial (null) values.
    // Defensive, matching every other interactive layer on this map after
    // repeated live reports of clicks falling through to the map's own
    // "move the active radio here" handler underneath them — a plain
    // click (not a drag) on this marker should only open its own popup,
    // never also re-place itself via the map's click handler.
    marker.on('click', (e: L.LeafletMouseEvent) => L.DomEvent.stopPropagation(e));
    siteMarkerRef.current = marker;

    // Deliberately no map.on('click', ...) here anymore. It used to move
    // the active radio to wherever the map was clicked — meant as a quick
    // way to place a brand-new radio, but it meant *any* click on empty
    // map space (e.g. after selecting a different radio, or just clicking
    // around) silently relocated whatever was currently loaded. Moving a
    // radio is drag-only now; placing a new one goes through "Add Radio" /
    // "Quick Add 3-Sector Site" instead.

    const drawnItems = new L.FeatureGroup().addTo(map);
    drawnItemsRef.current = drawnItems;

    const drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#38bdf8' } },
        polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false,
      },
      // leaflet-draw's own Edit/Delete toolbar (edit: {featureGroup, remove:
      // true}) is what used to sit here — two buttons right under the
      // polygon tool that, per repeated live reports, simply did nothing
      // when clicked (a real leaflet-draw 1.0.4 + Leaflet 1.9.x rough edge,
      // not just a labeling problem). Rather than keep fighting a 3rd-party
      // library's internal edit-mode state machine with no browser to watch
      // it in, edit is fully disabled and replaced with our own single
      // "Clear Drawn Area" control right below — plain code we control, one
      // click, no modal edit/delete-select mode to get stuck in. Re-drawing
      // a polygon from scratch already replaces the old one (see the
      // CREATED handler below), so a reshape/edit tool isn't load-bearing.
      // (@types/leaflet-draw only types `edit` as EditOptions, not
      // `EditOptions | false` — the underlying JS checks truthiness, so
      // omitting the key entirely is the type-safe way to get the same
      // "no edit toolbar" runtime behavior as passing false.)
    });
    map.addControl(drawControl);

    const ClearAreaControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: () => {
        const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
        const link = L.DomUtil.create('a', '', container) as HTMLAnchorElement;
        link.href = '#';
        link.title = 'Clear drawn coverage area';
        link.setAttribute('aria-label', 'Clear drawn coverage area');
        link.innerHTML = '🗑';
        link.style.cssText = 'display:flex;align-items:center;justify-content:center;font-size:16px;width:30px;height:30px;';
        L.DomEvent.on(link, 'click', (e: Event) => {
          L.DomEvent.stop(e);
          clearPolygon();
        });
        return container;
      },
    });
    map.addControl(new ClearAreaControl());

    const syncPolygonFromLayer = (layer: L.Layer) => {
      const latlngs = (layer as L.Polygon).getLatLngs()[0] as L.LatLng[];
      setPolygon(latlngs.map(ll => ({ lat: ll.lat, lon: ll.lng })));
    };

    map.on(L.Draw.Event.CREATED, (e: L.LeafletEvent) => {
      const created = e as unknown as L.DrawEvents.Created;
      drawnItems.clearLayers(); // one target polygon at a time
      drawnItems.addLayer(created.layer);
      syncPolygonFromLayer(created.layer);
    });
    map.on(L.Draw.Event.EDITED, (e: L.LeafletEvent) => {
      const edited = e as unknown as L.DrawEvents.Edited;
      edited.layers.eachLayer(layer => syncPolygonFromLayer(layer));
    });
    map.on(L.Draw.Event.DELETED, () => setPolygon([]));

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the marker (and, on first load, the map view) synced with manually-typed lat/lon.
  useEffect(() => {
    const lat = Number(site.lat), lon = Number(site.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !siteMarkerRef.current || !mapRef.current) return;
    siteMarkerRef.current.setLatLng([lat, lon]);
  }, [site.lat, site.lon]);

  // Drag handling + delete popup on the active (gold, draggable) marker —
  // rebound fresh whenever which site is loaded changes, since dragend
  // needs to know (a) whether this radio is currently a saved site at all
  // (a fresh, never-saved draft just updates local form state) and (b)
  // whether it belongs to a tower group, in which case every sibling
  // sector must shift by the same lat/lon delta so the whole tower moves
  // as one object instead of just the sector you happened to grab.
  useEffect(() => {
    if (!siteMarkerRef.current) return;
    const marker = siteMarkerRef.current;
    const loaded = loadedSiteId && activeProject ? activeProject.sites.find(s => s.id === loadedSiteId) : null;

    let dragStart: L.LatLng | null = null;
    marker.off('dragstart').on('dragstart', () => { dragStart = marker.getLatLng(); });
    marker.off('dragend').on('dragend', () => {
      const ll = marker.getLatLng();
      if (loaded && activeProject && dragStart) {
        const deltaLat = ll.lat - dragStart.lat;
        const deltaLon = ll.lng - dragStart.lng;
        const group = loaded.towerId
          ? activeProject.sites.filter(s => s.towerId === loaded.towerId)
          : [loaded];
        moveSites(activeProject, group, deltaLat, deltaLon);
      } else {
        setSite(s => ({ ...s, lat: ll.lat.toFixed(6), lon: ll.lng.toFixed(6) }));
      }
    });

    marker.off('contextmenu');
    if (!loaded) { marker.unbindPopup(); return; }
    // Right-click delete, same as every other radio's dot — doesn't depend
    // on the popup opening correctly, and needs no prior selection step.
    marker.on('contextmenu', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      e.originalEvent?.preventDefault();
      if (window.confirm(`Delete radio "${loaded.name}"? This cannot be undone.`)) deleteSite(loaded.id);
    });
    marker.bindPopup(buildSitePopup(loaded.name, () => {
      mapRef.current?.closePopup();
      if (window.confirm(`Delete radio "${loaded.name}"? This cannot be undone.`)) deleteSite(loaded.id);
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedSiteId, activeProject]);

  // Boresight cone overlay — redraws whenever pointing/beamwidth/radius inputs change.
  useEffect(() => {
    if (!mapRef.current) return;
    if (coneLayerRef.current) {
      mapRef.current.removeLayer(coneLayerRef.current);
      coneLayerRef.current = null;
    }
    const lat = Number(site.lat), lon = Number(site.lon);
    const azimuth = Number(antenna.azimuthDeg), beamwidth = Number(antenna.horizontalBeamwidthDeg), radiusM = Number(grid.radiusM);
    if (![lat, lon, azimuth, beamwidth, radiusM].every(Number.isFinite) || beamwidth <= 0 || radiusM <= 0) return;

    // interactive:false is load-bearing, not cosmetic — this cone is large
    // (its radius is the whole grid radius, up to km-scale) and, being
    // freshly (re)drawn on every render, always sits on top of any other
    // radio's cone/dot underneath it. Without this, it silently swallows
    // clicks meant for other radios at/near the same location (e.g. every
    // sector of a 3-sector site shares one point) — the click never
    // reaches their stopPropagation-guarded handlers at all, so it falls
    // through to the map's own click handler, which moves *this* (the
    // active) radio to wherever was clicked. That's the exact bug
    // reported live: clicking a second radio "just moved the first one."
    const cone = L.polygon(boresightCone(lat, lon, azimuth, beamwidth, radiusM), {
      color: '#38bdf8', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.08, interactive: false,
    }).addTo(mapRef.current);
    coneLayerRef.current = cone;
  }, [site.lat, site.lon, antenna.azimuthDeg, antenna.horizontalBeamwidthDeg, grid.radiusM]);

  // Other saved sites in the active project — shown as a distinct color so
  // candidate placements can be visually compared against the site
  // currently being edited (blue). Clicking the dot loads that radio into
  // the edit form/draggable marker, the same as the site list's own "Load"
  // button — the map itself is a way to select a radio to manage, not just
  // a static preview of the other saved ones.
  //
  // Two things this deliberately does differently after repeated live
  // reports that selection was unreliable:
  //  1. The currently-loaded site is excluded from this ghost layer
  //     entirely (see loadedSiteId) — it was previously drawn TWICE (once
  //     as this loop's own ghost cone/dot, again as the real draggable
  //     blue marker on top of it), and that self-overlap was the actual
  //     root cause of clicks landing on the wrong thing.
  //  2. Only the small dot is interactive — the cone is decorative only
  //     (interactive:false). A cone is large (up to km-scale) and, for two
  //     radios anywhere near each other, cones overlap far more readily
  //     than the small dots do; letting the cone swallow clicks meant for
  //     a neighboring radio's dot underneath it was the same class of bug
  //     as the active site's own cone (see the boresight cone effect
  //     above) and the heatmap cells (see below) — both fixed the same way.
  useEffect(() => {
    if (!mapRef.current || !projectSitesGroupRef.current) return;
    projectSitesGroupRef.current.clearLayers();
    if (!activeProject) return;
    for (const s of activeProject.sites) {
      if (s.id && s.id === loadedSiteId) continue;
      const onDeleteClick = () => {
        mapRef.current?.closePopup();
        if (window.confirm(`Delete radio "${s.name}"? This cannot be undone.`)) deleteSite(s.id);
      };
      L.polygon(boresightCone(s.siteLat, s.siteLon, s.azimuthDeg, s.horizontalBeamwidthDeg, 2000), {
        color: '#a855f7', weight: 1, fillColor: '#a855f7', fillOpacity: 0.1, interactive: false,
      }).addTo(projectSitesGroupRef.current);
      const dot = L.circleMarker([s.siteLat, s.siteLon], { radius: 6, color: '#a855f7', fillColor: '#a855f7', fillOpacity: 1 })
        .bindTooltip(`${s.name} (click to select)`)
        .bindPopup(buildSitePopup(s.name, onDeleteClick))
        .addTo(projectSitesGroupRef.current);
      // Without stopping propagation, this click bubbles up to the map's
      // own click handler right after firing (Leaflet's default behavior),
      // which then also runs its "move the active site here" logic —
      // clobbering the just-loaded site's real coordinates with whatever
      // pixel was clicked instead. That's the exact bug reported live:
      // clicking a second radio looked like "the first radio jumped to
      // where I clicked" rather than actually selecting the second one.
      dot.on('click', (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); loadSite(s); });
      // Real bug found live: left-clicking a not-yet-selected radio's dot
      // both (a) tries to open ITS bound popup and (b) calls loadSite(s),
      // which changes loadedSiteId — which re-runs THIS effect, which
      // clears and rebuilds the whole layer group (this dot now excluded,
      // since it's the loaded one) BEFORE the popup that just opened on it
      // could ever be clicked. The delete button inside it was destroyed
      // out from under the user practically as soon as it appeared — a
      // radio could only actually be deleted via its popup on the *second*
      // click, once it was already the active marker, which looked
      // indistinguishable from "the delete button does nothing." Right-
      // click sidesteps all of that: it acts immediately, on this exact
      // layer, with no selection step and no dependency on this effect
      // re-running first.
      dot.on('contextmenu', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(e);
        e.originalEvent?.preventDefault();
        onDeleteClick();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject, loadedSiteId]);

  // Unified data source for the "coverage" heatmap layer: a single site's
  // own coverageGrid result, or — once 2+ radios are in the active project —
  // the merged multi-site interference result's per-cell serving signal
  // (InterferenceCell.servingDbm is already "the strongest site's signal at
  // this point," the standard best-server convention for a combined
  // coverage map). Both CoverageGridResult and InterferenceGridResult share
  // the same rows/cols/bounds shape, so one rendering path below can serve
  // either without duplicating the drawing logic.
  const coverageSource = res?.ok && res.result
    ? {
        cells: res.result.cells.map(c => ({ lat: c.lat, lon: c.lon, row: c.row, col: c.col, value: c.totalReceivedPowerDbm })),
        rows: res.result.rows, cols: res.result.cols, bounds: res.result.bounds,
      }
    : interferenceResult?.ok && interferenceResult.result
      ? {
          cells: interferenceResult.result.cells
            .filter((c): c is typeof c & { servingDbm: number } => c.servingDbm != null)
            .map(c => ({ lat: c.lat, lon: c.lon, row: c.row, col: c.col, value: c.servingDbm })),
          rows: interferenceResult.result.rows, cols: interferenceResult.result.cols, bounds: interferenceResult.result.bounds,
        }
      : null;

  // Coverage heatmap render — redraws whenever a new calculation result
  // comes back, the view toggles, or smoothing is switched on/off.
  useEffect(() => {
    if (!mapRef.current || !heatmapGroupRef.current) return;
    heatmapGroupRef.current.clearLayers();
    if (activeHeatmap !== 'coverage' || !coverageSource) return;
    const { cells, rows, cols, bounds } = coverageSource;

    if (smoothHeatmap) {
      const dataUrl = buildSmoothOverlayDataUrl(cells, rows, cols, dbmToColor);
      if (dataUrl) {
        L.imageOverlay(dataUrl, [[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]], { interactive: false })
          .addTo(heatmapGroupRef.current);
      }
    } else {
      const halfLat = (bounds.maxLat - bounds.minLat) / rows / 2;
      const halfLon = (bounds.maxLon - bounds.minLon) / cols / 2;
      for (const cell of cells) {
        // interactive:false — otherwise these cells (covering the whole
        // grid area, up to MAX_GRID_CELLS of them) sit on top of and
        // swallow clicks meant for any radio marker/cone underneath, the
        // same class of bug as the active boresight cone above: the click
        // never reaches the radio's own handler, so it falls through to
        // the map's "move the active radio here" click handler instead.
        L.rectangle(
          [[cell.lat - halfLat, cell.lon - halfLon], [cell.lat + halfLat, cell.lon + halfLon]],
          {
            renderer: canvasRendererRef.current ?? undefined,
            color: dbmToColor(cell.value),
            weight: 0,
            fillColor: dbmToColor(cell.value),
            fillOpacity: 0.55,
            interactive: false,
          },
        ).addTo(heatmapGroupRef.current);
      }
    }

    if (!hasFitBoundsRef.current) {
      mapRef.current.fitBounds([[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]]);
      hasFitBoundsRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverageSource, activeHeatmap, smoothHeatmap]);

  // SINR heatmap render — always sourced from the multi-site interference
  // result (SINR is only meaningful with 2+ sites), toggled via the same
  // Combined Coverage / SINR switch as the coverage layer above.
  useEffect(() => {
    if (!mapRef.current || !interferenceGroupRef.current) return;
    interferenceGroupRef.current.clearLayers();
    if (activeHeatmap !== 'interference' || !interferenceResult?.ok || !interferenceResult.result) return;

    const { cells, rows, cols, bounds } = interferenceResult.result;

    if (smoothHeatmap) {
      const sinrCells = cells
        .filter((c): c is typeof c & { sinrDb: number } => c.sinrDb != null)
        .map(c => ({ row: c.row, col: c.col, value: c.sinrDb }));
      const dataUrl = buildSmoothOverlayDataUrl(sinrCells, rows, cols, sinrToColor);
      if (dataUrl) {
        L.imageOverlay(dataUrl, [[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]], { interactive: false })
          .addTo(interferenceGroupRef.current);
      }
    } else {
      const halfLat = (bounds.maxLat - bounds.minLat) / rows / 2;
      const halfLon = (bounds.maxLon - bounds.minLon) / cols / 2;
      for (const cell of cells) {
        if (cell.sinrDb == null) continue;
        // interactive:false — see the matching comment on the coverage
        // heatmap's own rectangles above.
        L.rectangle(
          [[cell.lat - halfLat, cell.lon - halfLon], [cell.lat + halfLat, cell.lon + halfLon]],
          {
            renderer: canvasRendererRef.current ?? undefined,
            color: sinrToColor(cell.sinrDb), weight: 0, fillColor: sinrToColor(cell.sinrDb), fillOpacity: 0.55,
            interactive: false,
          },
        ).addTo(interferenceGroupRef.current);
      }
    }

    mapRef.current.fitBounds([[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]]);
  }, [interferenceResult, activeHeatmap, smoothHeatmap]);

  const useMyLocation = () => {
    if (!navigator.geolocation) { toast.error('Geolocation not available in this browser'); return; }
    navigator.geolocation.getCurrentPosition(
      pos => setSite(s => ({ ...s, lat: pos.coords.latitude.toFixed(6), lon: pos.coords.longitude.toFixed(6) })),
      () => toast.error('Could not get your location'),
    );
  };

  const clearPolygon = () => {
    drawnItemsRef.current?.clearLayers();
    setPolygon([]);
  };

  const buildSiteInput = (): Omit<RfPlanningSite, 'id' | 'name'> => ({
    siteLat: Number(site.lat), siteLon: Number(site.lon), siteHeightM: Number(site.heightM),
    azimuthDeg: Number(antenna.azimuthDeg), horizontalBeamwidthDeg: Number(antenna.horizontalBeamwidthDeg),
    verticalBeamwidthDeg: antenna.verticalBeamwidthDeg ? Number(antenna.verticalBeamwidthDeg) : undefined,
    mechanicalDowntiltDeg: antenna.mechanicalDowntiltDeg ? Number(antenna.mechanicalDowntiltDeg) : undefined,
    electricalDowntiltDeg: antenna.electricalDowntiltDeg ? Number(antenna.electricalDowntiltDeg) : undefined,
    frontToBackDb: antenna.frontToBackDb ? Number(antenna.frontToBackDb) : undefined,
    txPowerDbm: Number(radio.txPowerDbm), cableLossDb: Number(radio.cableLossDb),
    connectorLossDb: Number(radio.connectorLossDb),
    filterLossDb: radio.filterLossDb ? Number(radio.filterLossDb) : undefined,
    antennaGainDbi: Number(radio.antennaGainDbi),
    frequencyMhz: radio.frequencyMhz ? Number(radio.frequencyMhz) : undefined,
    buildingLossDb: propagation.buildingLossDb ? Number(propagation.buildingLossDb) : undefined,
    foliageLossDb: propagation.foliageLossDb ? Number(propagation.foliageLossDb) : undefined,
    miscLossDb: propagation.miscLossDb ? Number(propagation.miscLossDb) : undefined,
    ueAntennaGainDbi: propagation.ueAntennaGainDbi ? Number(propagation.ueAntennaGainDbi) : undefined,
    receiverHeightM: propagation.receiverHeightM ? Number(propagation.receiverHeightM) : undefined,
    propagationModel: model.propagationModel,
    environment: model.propagationModel === 'hata' && !model.autoDetectEnvironment ? model.environment : undefined,
    cityType: (model.propagationModel === 'cost231-hata' || model.propagationModel === 'walfisch-ikegami') && !model.autoDetectEnvironment ? model.cityType : undefined,
    autoDetectEnvironment: (model.propagationModel === 'hata' || model.propagationModel === 'cost231-hata' || model.propagationModel === 'walfisch-ikegami') ? model.autoDetectEnvironment : undefined,
    useTerrainData: model.useTerrainData,
    isLineOfSight: model.propagationModel === 'close-in' && !model.useTerrainData ? model.isLineOfSight : undefined,
    pathLossExponent: (model.propagationModel === 'close-in' || model.propagationModel === 'log-distance') && model.pathLossExponent
      ? Number(model.pathLossExponent) : undefined,
    logDistanceEnvironment: model.propagationModel === 'log-distance' ? model.logDistanceEnvironment : undefined,
    walfischIkegamiMode: model.propagationModel === 'walfisch-ikegami' ? model.walfischIkegamiMode : undefined,
    buildingHeightM: model.propagationModel === 'walfisch-ikegami' && model.buildingHeightM ? Number(model.buildingHeightM) : undefined,
    streetWidthM: model.propagationModel === 'walfisch-ikegami' && model.streetWidthM ? Number(model.streetWidthM) : undefined,
    buildingSeparationM: model.propagationModel === 'walfisch-ikegami' && model.buildingSeparationM ? Number(model.buildingSeparationM) : undefined,
    streetOrientationDeg: model.propagationModel === 'walfisch-ikegami' && model.streetOrientationDeg ? Number(model.streetOrientationDeg) : undefined,
    radioClimate: model.propagationModel === 'itm' ? model.radioClimate : undefined,
    polarization: model.propagationModel === 'itm' ? model.polarization : undefined,
    modeOfVariability: model.propagationModel === 'itm' ? model.modeOfVariability : undefined,
    timePercent: model.propagationModel === 'itm' && model.timePercent ? Number(model.timePercent) : undefined,
    locationPercent: model.propagationModel === 'itm' && model.locationPercent ? Number(model.locationPercent) : undefined,
    situationPercent: model.propagationModel === 'itm' && model.situationPercent ? Number(model.situationPercent) : undefined,
    groundConductivity: model.propagationModel === 'itm' && model.groundConductivity ? Number(model.groundConductivity) : undefined,
    groundPermittivity: model.propagationModel === 'itm' && model.groundPermittivity ? Number(model.groundPermittivity) : undefined,
    surfaceRefractivityN0: model.propagationModel === 'itm' && model.surfaceRefractivityN0 ? Number(model.surfaceRefractivityN0) : undefined,
  });

  // With 0-1 radios, this is a single-site coverageGrid call exactly as
  // before. With 2+ radios in the active project, it instead calls the
  // multi-site interference endpoint — already built/tested for the
  // separate SINR feature — and treats its per-cell servingDbm as the
  // combined coverage heatmap (best-server signal at each point), so
  // multiple radios mesh into one coherent view instead of N overlapping
  // single-site ones. The polygon-driven coverage-requirement/in-area-stats
  // panels have no multi-site backend analog yet, so they stay tied to
  // `res` and simply don't appear once in multi-site mode ("Compare Saved
  // Sites" already covers the closest multi-site equivalent of that need).
  const submit = async () => {
    setLoading(true);
    setRes(null);
    setInterferenceResult(null);
    setActiveHeatmap('coverage');
    hasFitBoundsRef.current = false;
    try {
      if (activeProject && activeProject.sites.length >= 2) {
        const result = await rfPlanningProjectsApi.interference(activeProject.id, {
          radiusM: Number(grid.radiusM), resolution: Number(grid.resolution),
        });
        setInterferenceResult(result);
        if (!result.ok) toast.error(result.error?.reason || 'Calculation failed');
      } else {
        const input: CoverageGridInput = {
          ...buildSiteInput(),
          radiusM: Number(grid.radiusM), resolution: Number(grid.resolution),
          targetPolygon: polygon.length >= 3 ? polygon : undefined,
          minAcceptableSignalDbm: polygon.length >= 3 && grid.minAcceptableSignalDbm
            ? Number(grid.minAcceptableSignalDbm) : undefined,
        };
        const result = await rfPlanningApi.coverageGrid(input);
        setRes(result);
        if (!result.ok) toast.error(result.error?.reason || 'Calculation failed');
      }
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.reason || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  const createProject = async () => {
    const name = window.prompt('Project name?');
    if (!name) return;
    try {
      const project = await rfPlanningProjectsApi.create(name);
      setProjects(p => [project, ...p]);
      setActiveProjectId(project.id);
      toast.success('Project created');
    } catch { toast.error('Failed to create project'); }
  };

  const deleteProject = async () => {
    if (!activeProject) return;
    if (!window.confirm(`Delete project "${activeProject.name}"? This cannot be undone.`)) return;
    try {
      await rfPlanningProjectsApi.remove(activeProject.id);
      setProjects(ps => ps.filter(p => p.id !== activeProject.id));
      setActiveProjectId('');
      setComparison(null);
    } catch { toast.error('Failed to delete project'); }
  };

  const saveAsSite = async () => {
    if (!activeProject) { toast.error('Select or create a project first'); return; }
    const name = window.prompt('Site name?');
    if (!name) return;
    try {
      const newSite = { id: '', name, ...buildSiteInput() } as RfPlanningSite;
      const updated = await rfPlanningProjectsApi.update(activeProject.id, {
        sites: [...activeProject.sites, newSite],
        targetPolygon: polygon.length >= 3 ? polygon : activeProject.targetPolygon,
        minAcceptableSignalDbm: grid.minAcceptableSignalDbm ? Number(grid.minAcceptableSignalDbm) : activeProject.minAcceptableSignalDbm,
      });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      toast.success(`Saved "${name}" to ${activeProject.name}`);
    } catch { toast.error('Failed to save site'); }
  };

  // Silently creates a project when adding a radio with none active yet —
  // multi-radio management needs somewhere to live, and requiring the user
  // to explicitly create one first is friction "Add Radio" shouldn't have.
  const ensureActiveProject = async (): Promise<RfPlanningProject> => {
    if (activeProject) return activeProject;
    const project = await rfPlanningProjectsApi.create('Untitled Project');
    setProjects(p => [project, ...p]);
    setActiveProjectId(project.id);
    return project;
  };

  const addRadio = async () => {
    const name = window.prompt('Radio name?', 'New Radio');
    if (!name) return;
    try {
      const project = await ensureActiveProject();
      const newSite = { id: '', name, ...buildSiteInput() } as RfPlanningSite;
      const updated = await rfPlanningProjectsApi.update(project.id, { sites: [...project.sites, newSite] });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      loadSite(updated.sites[updated.sites.length - 1]);
      toast.success(`Added "${name}"`);
    } catch { toast.error('Failed to add radio'); }
  };

  // A real tri-sector tower: 3 radios at the current form's location/height/
  // radio settings, differing only in azimuth/beamwidth — both supplied by
  // the QuickAdd3SectorModal, not assumed (a real tower isn't always an
  // even 120° split, and reusing whatever beamwidth was already in the form
  // was a silent, easy-to-miss assumption for a brand new tower).
  const quickAdd3Sector = async (opts: { name: string; startAzimuthDeg: number; spacingDeg: number; beamwidthDeg: number }) => {
    try {
      const project = await ensureActiveProject();
      const template = buildSiteInput();
      // Not crypto.randomUUID() — this app is also served over plain HTTP
      // (nginx on 80/8888, not just the HTTPS SAS port), and randomUUID()
      // throws outside a secure context in some browsers. This id is only
      // ever a client-side grouping label, never security-sensitive.
      const towerId = `tower-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const azimuths = [0, 1, 2].map(i => ((opts.startAzimuthDeg + i * opts.spacingDeg) % 360 + 360) % 360);
      const newSites = azimuths.map((az, i) => ({
        id: '', name: `${opts.name} — ${SECTOR_LABELS[i]}`, ...template,
        azimuthDeg: az, horizontalBeamwidthDeg: opts.beamwidthDeg, towerId,
      })) as RfPlanningSite[];
      const updated = await rfPlanningProjectsApi.update(project.id, { sites: [...project.sites, ...newSites] });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      setShow3SectorModal(false);
      toast.success(`Added 3-sector site "${opts.name}" (${azimuths.map(a => `${Math.round(a)}°`).join('/')})`);
    } catch { toast.error('Failed to add 3-sector site'); }
  };

  const loadSite = (s: RfPlanningSite) => {
    setLoadedSiteId(s.id || null);
    setSite({ lat: String(s.siteLat), lon: String(s.siteLon), heightM: String(s.siteHeightM) });
    setAntenna({
      azimuthDeg: String(s.azimuthDeg), horizontalBeamwidthDeg: String(s.horizontalBeamwidthDeg),
      verticalBeamwidthDeg: s.verticalBeamwidthDeg != null ? String(s.verticalBeamwidthDeg) : '',
      mechanicalDowntiltDeg: s.mechanicalDowntiltDeg != null ? String(s.mechanicalDowntiltDeg) : '',
      electricalDowntiltDeg: s.electricalDowntiltDeg != null ? String(s.electricalDowntiltDeg) : '',
      frontToBackDb: s.frontToBackDb != null ? String(s.frontToBackDb) : '',
    });
    setRadio({
      txPowerDbm: String(s.txPowerDbm), cableLossDb: String(s.cableLossDb), connectorLossDb: String(s.connectorLossDb),
      filterLossDb: s.filterLossDb != null ? String(s.filterLossDb) : '',
      antennaGainDbi: String(s.antennaGainDbi), frequencyMhz: s.frequencyMhz != null ? String(s.frequencyMhz) : '',
    });
    setPropagation({
      buildingLossDb: s.buildingLossDb != null ? String(s.buildingLossDb) : '',
      foliageLossDb: s.foliageLossDb != null ? String(s.foliageLossDb) : '',
      miscLossDb: s.miscLossDb != null ? String(s.miscLossDb) : '',
      ueAntennaGainDbi: s.ueAntennaGainDbi != null ? String(s.ueAntennaGainDbi) : '',
      receiverHeightM: s.receiverHeightM != null ? String(s.receiverHeightM) : '',
    });
    setModel({
      propagationModel: s.propagationModel ?? 'fspl',
      environment: s.environment ?? 'urban',
      cityType: s.cityType ?? 'medium',
      autoDetectEnvironment: !!s.autoDetectEnvironment,
      useTerrainData: !!s.useTerrainData,
      isLineOfSight: !!s.isLineOfSight,
      pathLossExponent: s.pathLossExponent != null ? String(s.pathLossExponent) : '',
      logDistanceEnvironment: s.logDistanceEnvironment ?? 'urban',
      walfischIkegamiMode: s.walfischIkegamiMode ?? 'nlos',
      buildingHeightM: s.buildingHeightM != null ? String(s.buildingHeightM) : '',
      streetWidthM: s.streetWidthM != null ? String(s.streetWidthM) : '',
      buildingSeparationM: s.buildingSeparationM != null ? String(s.buildingSeparationM) : '',
      streetOrientationDeg: s.streetOrientationDeg != null ? String(s.streetOrientationDeg) : '',
      radioClimate: s.radioClimate ?? 'continental-temperate',
      polarization: s.polarization ?? 'horizontal',
      modeOfVariability: s.modeOfVariability ?? 'broadcast',
      groundConductivity: s.groundConductivity != null ? String(s.groundConductivity) : '',
      groundPermittivity: s.groundPermittivity != null ? String(s.groundPermittivity) : '',
      surfaceRefractivityN0: s.surfaceRefractivityN0 != null ? String(s.surfaceRefractivityN0) : '',
      timePercent: s.timePercent != null ? String(s.timePercent) : '',
      locationPercent: s.locationPercent != null ? String(s.locationPercent) : '',
      situationPercent: s.situationPercent != null ? String(s.situationPercent) : '',
    });
    toast.success(`Loaded "${s.name}"`);
  };

  const deleteSite = async (siteId: string) => {
    if (!activeProject) return;
    try {
      const updated = await rfPlanningProjectsApi.update(activeProject.id, { sites: activeProject.sites.filter(s => s.id !== siteId) });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      // The marker/form state is independent of activeProject.sites, so
      // without this, deleting the currently-loaded radio left the marker
      // sitting exactly where it was with no visual change — looking
      // exactly like the delete silently failed, especially with only one
      // radio in the project (nothing else on the map to compare against).
      // Load whatever's left, or clear the selection entirely.
      if (loadedSiteId === siteId) {
        const next = updated.sites[0];
        if (next) loadSite(next); else setLoadedSiteId(null);
      }
      toast.success('Radio deleted');
    } catch { toast.error('Failed to delete site'); }
  };

  // Persists a lat/lon shift for one or more sites in a single atomic
  // update — used for both a lone radio's drag (targets = [loaded]) and a
  // whole tower's drag (targets = every site sharing its towerId), so a
  // drag always immediately reflects saved truth instead of leaving an
  // unsaved local position that loading a different radio would silently
  // discard.
  const moveSites = async (project: RfPlanningProject, targets: RfPlanningSite[], deltaLat: number, deltaLon: number) => {
    const targetIds = new Set(targets.map(s => s.id));
    const shifted = project.sites.map(s => (targetIds.has(s.id) ? { ...s, siteLat: s.siteLat + deltaLat, siteLon: s.siteLon + deltaLon } : s));
    try {
      const updated = await rfPlanningProjectsApi.update(project.id, { sites: shifted });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      const stillLoaded = loadedSiteId ? updated.sites.find(s => s.id === loadedSiteId) : null;
      if (stillLoaded) setSite(s => ({ ...s, lat: String(stillLoaded.siteLat), lon: String(stillLoaded.siteLon) }));
    } catch { toast.error('Failed to move radio'); }
  };

  const ungroupTower = async () => {
    if (!activeProject || !loadedSiteId) return;
    const loaded = activeProject.sites.find(s => s.id === loadedSiteId);
    if (!loaded?.towerId) return;
    if (!window.confirm('Ungroup this tower? Its radios can then be moved independently.')) return;
    const groupId = loaded.towerId;
    const ungrouped = activeProject.sites.map(s => (s.towerId === groupId ? { ...s, towerId: undefined } : s));
    try {
      const updated = await rfPlanningProjectsApi.update(activeProject.id, { sites: ungrouped });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      toast.success('Tower ungrouped — radios can now be moved independently');
    } catch { toast.error('Failed to ungroup tower'); }
  };

  const compareSites = async () => {
    if (!activeProject) return;
    if (polygon.length < 3) { toast.error('Draw a target area on the map first'); return; }
    const threshold = grid.minAcceptableSignalDbm ? Number(grid.minAcceptableSignalDbm) : undefined;
    if (threshold == null) { toast.error('Set Min Acceptable Signal first'); return; }
    if (activeProject.sites.length === 0) { toast.error('This project has no saved sites yet'); return; }
    setComparing(true);
    setComparison(null);
    try {
      const results = await rfPlanningProjectsApi.compareSites(activeProject.id, polygon, threshold, Number(grid.radiusM), Number(grid.resolution));
      setComparison(results);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Comparison failed');
    } finally {
      setComparing(false);
    }
  };

  const addSurveyPoint = async () => {
    if (!activeProject || !surveySiteId) { toast.error('Select a project and site first'); return; }
    const lat = Number(surveyForm.lat), lon = Number(surveyForm.lon), measuredDbm = Number(surveyForm.measuredDbm);
    if (![lat, lon, measuredDbm].every(Number.isFinite)) { toast.error('Latitude, longitude, and measured signal are all required'); return; }
    try {
      const updated = await rfPlanningProjectsApi.addSurveyPoint(activeProject.id, surveySiteId, { lat, lon, measuredDbm });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
      setSurveyForm({ lat: '', lon: '', measuredDbm: '' });
      toast.success('Survey point added');
    } catch { toast.error('Failed to add survey point'); }
  };

  const removeSurveyPoint = async (index: number) => {
    if (!activeProject || !surveySiteId) return;
    try {
      const updated = await rfPlanningProjectsApi.removeSurveyPoint(activeProject.id, surveySiteId, index);
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
    } catch { toast.error('Failed to remove survey point'); }
  };

  const computeCalibration = async () => {
    if (!activeProject || !surveySiteId) return;
    setLoadingCalibration(true);
    setCalibration(null);
    try {
      const result = await rfPlanningProjectsApi.calibration(activeProject.id, surveySiteId);
      setCalibration(result);
      if (!result) toast.error('No survey points could be evaluated for this site');
    } catch { toast.error('Failed to compute calibration'); }
    finally { setLoadingCalibration(false); }
  };

  const surveySite = activeProject?.sites.find(s => s.id === surveySiteId) ?? null;

  const inPolygonCells = res?.ok && res.result ? res.result.cells.filter(c => c.insideTargetPolygon) : [];
  const inPolygonStats = inPolygonCells.length > 0 ? {
    min: Math.min(...inPolygonCells.map(c => c.totalReceivedPowerDbm)),
    max: Math.max(...inPolygonCells.map(c => c.totalReceivedPowerDbm)),
    avg: inPolygonCells.reduce((s, c) => s + c.totalReceivedPowerDbm, 0) / inPolygonCells.length,
  } : null;

  // Error/calculation/assumptions/warnings display is generic across both
  // result types — every CalculationResult<T> shares this envelope
  // regardless of T, only `result` itself differs (and isn't read here).
  const activeResult = (res ?? interferenceResult) as CalculationResult<unknown> | null;

  return (
    <div className="space-y-6">
      {show3SectorModal && (
        <QuickAdd3SectorModal
          defaultBeamwidthDeg={antenna.horizontalBeamwidthDeg}
          onClose={() => setShow3SectorModal(false)}
          onConfirm={opts => quickAdd3Sector(opts)}
        />
      )}
      <div className="nms-card space-y-3">
        <p className="text-sm font-semibold text-nms-text">Project</p>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="nms-input flex-1 min-w-[200px]" value={activeProjectId} onChange={e => { setActiveProjectId(e.target.value); setComparison(null); setLoadedSiteId(null); }}>
            <option value="">— No project selected (unsaved) —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sites.length} site{p.sites.length === 1 ? '' : 's'})</option>)}
          </select>
          <button type="button" onClick={createProject} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <Plus className="w-3.5 h-3.5" /> New Project
          </button>
          <button type="button" onClick={saveAsSite} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <Save className="w-3.5 h-3.5" /> Save Current as Site
          </button>
          <button type="button" onClick={addRadio} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <RadioIcon className="w-3.5 h-3.5" /> Add Radio
          </button>
          <button type="button" onClick={() => setShow3SectorModal(true)} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <RadioTower className="w-3.5 h-3.5" /> Quick Add 3-Sector Site
          </button>
          {loadedSiteId && activeProject?.sites.some(s => s.id === loadedSiteId && s.towerId) && (
            <button type="button" onClick={ungroupTower} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <Ungroup className="w-3.5 h-3.5" /> Ungroup Tower
            </button>
          )}
          {loadedSiteId && activeProject?.sites.some(s => s.id === loadedSiteId) && (
            <button
              type="button"
              onClick={() => {
                if (!activeProject) return;
                const loaded = activeProject.sites.find(s => s.id === loadedSiteId);
                if (loaded && window.confirm(`Delete radio "${loaded.name}"? This cannot be undone.`)) deleteSite(loaded.id);
              }}
              className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-red-500/30 text-red-400"
            >
              <Trash2 className="w-3.5 h-3.5" /> Delete Loaded Radio
            </button>
          )}
          {activeProject && (
            <a href={rfPlanningProjectsApi.reportUrl(activeProject.id)} target="_blank" rel="noreferrer" className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <FileDown className="w-3.5 h-3.5" /> Download PDF Report
            </a>
          )}
          {activeProject && (
            <button type="button" onClick={deleteProject} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-red-500/30 text-red-400">
              <Trash2 className="w-3.5 h-3.5" /> Delete Project
            </button>
          )}
        </div>

        {activeProject && activeProject.sites.length > 0 && (
          <div className="space-y-1.5">
            {activeProject.sites.map(s => (
              <div key={s.id} className="flex items-center justify-between gap-2 bg-nms-bg border border-nms-border rounded-lg px-3 py-1.5">
                <div className="text-xs">
                  <span className="text-nms-text font-medium">{s.name}</span>
                  {s.towerId && (
                    <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-nms-accent/10 text-nms-accent text-[10px] font-medium align-middle">
                      <RadioTower className="w-2.5 h-2.5" /> Tower
                    </span>
                  )}
                  <span className="text-nms-text-dim ml-2">({s.siteLat.toFixed(4)}, {s.siteLon.toFixed(4)}) — az {s.azimuthDeg}°</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={() => loadSite(s)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1">
                    <FolderOpen className="w-3 h-3" /> Load
                  </button>
                  <button type="button" onClick={() => deleteSite(s.id)} className="nms-btn-ghost flex items-center gap-1 text-[11px] px-2 py-1 text-red-400">
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeProject && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            <button type="button" onClick={compareSites} disabled={comparing} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <Scale className="w-3.5 h-3.5" /> {comparing ? 'Comparing…' : 'Compare Saved Sites Against Drawn Area'}
            </button>
            <p className="text-[11px] text-nms-text-dim">
              For every site saved in this project, computes the TX power that site would need (at its own saved azimuth/tilt/antenna) to cover the drawn target area at the Min Acceptable Signal threshold below — a side-by-side comparison, not an automatic recommendation.
            </p>
            {comparison && (
              <div className="space-y-1.5">
                {comparison.map(c => (
                  <div key={c.siteId} className="flex items-center justify-between bg-nms-bg border border-nms-border rounded-lg px-3 py-1.5 text-xs">
                    <span className="text-nms-text font-medium">{c.siteName}</span>
                    {c.ok && c.coverageRequirement ? (
                      <span className="font-mono text-nms-text">{c.coverageRequirement.requiredTxPowerDbm.toFixed(2)} dBm required</span>
                    ) : (
                      <span className="text-red-400">{c.error?.reason ?? 'No result'}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeProject && activeProject.sites.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            <p className="text-sm font-semibold text-nms-text flex items-center gap-1.5"><Target className="w-3.5 h-3.5" /> Field-Survey Calibration</p>
            <select className="nms-input w-full" value={surveySiteId} onChange={e => { setSurveySiteId(e.target.value); setCalibration(null); }}>
              <option value="">— Select a site —</option>
              {activeProject.sites.map(s => <option key={s.id} value={s.id}>{s.name} ({(s.surveyPoints ?? []).length} survey point{(s.surveyPoints ?? []).length === 1 ? '' : 's'})</option>)}
            </select>
            {surveySite && (
              <>
                <div className="grid grid-cols-4 gap-2">
                  <NumField label="Latitude" value={surveyForm.lat} onChange={v => setSurveyForm(f => ({ ...f, lat: v }))} unit="deg" />
                  <NumField label="Longitude" value={surveyForm.lon} onChange={v => setSurveyForm(f => ({ ...f, lon: v }))} unit="deg" />
                  <NumField label="Measured Signal" value={surveyForm.measuredDbm} onChange={v => setSurveyForm(f => ({ ...f, measuredDbm: v }))} unit="dBm" />
                  <button type="button" onClick={addSurveyPoint} className="nms-btn-ghost text-xs border border-nms-border self-end">Add Point</button>
                </div>
                {(surveySite.surveyPoints ?? []).length > 0 && (
                  <div className="space-y-1">
                    {(surveySite.surveyPoints ?? []).map((p, i) => (
                      <div key={i} className="flex items-center justify-between bg-nms-bg border border-nms-border rounded px-2 py-1 text-[11px]">
                        <span className="text-nms-text-dim">({p.lat.toFixed(5)}, {p.lon.toFixed(5)}) — {p.measuredDbm} dBm</span>
                        <button type="button" onClick={() => removeSurveyPoint(i)} className="text-red-400"><Trash2 className="w-3 h-3" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <button type="button" onClick={computeCalibration} disabled={loadingCalibration || (surveySite.surveyPoints ?? []).length === 0} className="nms-btn-ghost text-xs border border-nms-border">
                  {loadingCalibration ? 'Computing…' : 'Compute Calibration Offset'}
                </button>
                {calibration && (
                  <div className="nms-card !p-3 space-y-1 text-xs">
                    <p>Calibration Offset: <span className="font-mono text-nms-text">{calibration.offsetDb.toFixed(2)} dB</span> (measured − predicted, averaged over {calibration.pointCount} point{calibration.pointCount === 1 ? '' : 's'}{calibration.skippedCount > 0 ? `, ${calibration.skippedCount} skipped` : ''})</p>
                    <p>Mean Absolute Error (uncalibrated): <span className="font-mono text-nms-text">{calibration.meanAbsErrorDb.toFixed(2)} dB</span></p>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <div className="nms-card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-semibold text-nms-text">
            Site &amp; Coverage Map — click a radio to select it, drag the highlighted pin to move it (dragging any sector of a 3-sector tower moves the whole tower — use "Ungroup Tower" to move sectors independently), right-click any radio to delete it, then use the polygon tool (top-right) to draw the area you want covered
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={useMyLocation} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <Crosshair className="w-3.5 h-3.5" /> Use My Location
            </button>
            <button type="button" onClick={clearPolygon} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <Trash2 className="w-3.5 h-3.5" /> Clear Drawn Area
            </button>
          </div>
        </div>
        <div ref={mapContainerRef} style={{ height: 760 }} className="rounded-lg overflow-hidden border border-nms-border" />
        <div className="flex items-center gap-4 flex-wrap text-[11px] text-nms-text-dim">
          {(activeHeatmap === 'coverage' ? LEGEND : SINR_LEGEND).map(l => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
              {l.label} ({l.range})
            </span>
          ))}
          {activeProject && activeProject.sites.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: '#a855f7' }} />
              {interferenceResult?.ok ? `All ${activeProject.sites.length} radios meshed into this combined view` : 'Other saved sites in this project'}
            </span>
          )}
          {interferenceResult?.ok && (
            <div className="flex items-center gap-1 p-0.5 bg-nms-surface-2 rounded-md border border-nms-border">
              <button
                type="button" onClick={() => setActiveHeatmap('coverage')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium ${activeHeatmap === 'coverage' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text'}`}
              >
                Combined Coverage
              </button>
              <button
                type="button" onClick={() => setActiveHeatmap('interference')}
                className={`px-2 py-0.5 rounded text-[11px] font-medium ${activeHeatmap === 'interference' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text'}`}
              >
                SINR
              </button>
            </div>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-nms-text-dim" title="Interpolates between computed grid points for display only — does not increase actual resolution or accuracy">
            <input type="checkbox" checked={smoothHeatmap} onChange={e => setSmoothHeatmap(e.target.checked)} className="nms-checkbox" />
            Smooth
          </label>
          <span className="ml-auto">
            {polygon.length >= 3 ? `Target area drawn (${polygon.length} vertices)` : 'No target area drawn yet'}
          </span>
        </div>
      </div>

      <div className="space-y-6">
        <div className="space-y-4 w-full">
          <div className="nms-card space-y-3">
            <p className="text-sm font-semibold text-nms-text">Site</p>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="Latitude" value={site.lat} onChange={setSiteField('lat')} unit="deg" />
              <NumField label="Longitude" value={site.lon} onChange={setSiteField('lon')} unit="deg" />
              <NumField label="Height" value={site.heightM} onChange={setSiteField('heightM')} unit="m" />
            </div>
          </div>

          <div className="nms-card space-y-3">
            <p className="text-sm font-semibold text-nms-text">Antenna Pointing</p>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="Azimuth" value={antenna.azimuthDeg} onChange={setAntennaField('azimuthDeg')} unit="deg, compass" />
              <NumField label="Horizontal Beamwidth" value={antenna.horizontalBeamwidthDeg} onChange={setAntennaField('horizontalBeamwidthDeg')} unit="deg" />
              <NumField label="Vertical Beamwidth" value={antenna.verticalBeamwidthDeg} onChange={setAntennaField('verticalBeamwidthDeg')} unit="deg" placeholder="10" />
              <NumField label="Mechanical Downtilt" value={antenna.mechanicalDowntiltDeg} onChange={setAntennaField('mechanicalDowntiltDeg')} unit="deg" placeholder="0" />
              <NumField label="Electrical Downtilt" value={antenna.electricalDowntiltDeg} onChange={setAntennaField('electricalDowntiltDeg')} unit="deg" placeholder="0" />
              <NumField label="Front-to-Back Ratio" value={antenna.frontToBackDb} onChange={setAntennaField('frontToBackDb')} unit="dB" placeholder="20" />
            </div>
          </div>

          <div className="nms-card space-y-3">
            <p className="text-sm font-semibold text-nms-text">Radio</p>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="TX Power" value={radio.txPowerDbm} onChange={setRadioField('txPowerDbm')} unit="dBm" />
              <NumField label="Antenna Gain" value={radio.antennaGainDbi} onChange={setRadioField('antennaGainDbi')} unit="dBi" />
              <NumField label="Frequency" value={radio.frequencyMhz} onChange={setRadioField('frequencyMhz')} unit="MHz" />
              <NumField label="Cable Loss" value={radio.cableLossDb} onChange={setRadioField('cableLossDb')} unit="dB" />
              <NumField label="Connector Loss" value={radio.connectorLossDb} onChange={setRadioField('connectorLossDb')} unit="dB" />
              <NumField label="Filter Loss" value={radio.filterLossDb} onChange={setRadioField('filterLossDb')} unit="dB" placeholder="0" />
            </div>
          </div>

          <div className="nms-card space-y-3">
            <p className="text-sm font-semibold text-nms-text">Propagation Model &amp; Terrain</p>
            <div className="grid grid-cols-3 gap-3">
              <SelectField
                label="Model" value={model.propagationModel}
                onChange={v => setModel(m => ({
                  ...m, propagationModel: v as PropagationModel,
                  // ITM has no abstract-distance fallback — its whole
                  // algorithm is terrain-profile-shaped — so selecting it
                  // forces real terrain on rather than leaving a checkbox
                  // the user could uncheck into a guaranteed server error.
                  useTerrainData: v === 'itm' ? true : m.useTerrainData,
                }))}
                options={[
                  { value: 'fspl', label: 'Free-Space Path Loss' },
                  { value: 'hata', label: 'Hata (150-1500 MHz, 30-200m towers)' },
                  { value: 'cost231-hata', label: 'COST-231-Hata (1500-2000 MHz, 30-200m towers)' },
                  { value: 'close-in', label: 'Close-In (any frequency/height — CBRS/small cell)' },
                  { value: 'log-distance', label: 'Log-Distance (configurable exponent, general-purpose)' },
                  { value: 'walfisch-ikegami', label: 'Walfisch-Ikegami (800-2000 MHz, urban street-level)' },
                  { value: 'itm', label: 'ITM / Longley-Rice (20-20000 MHz, real terrain profile required)' },
                ]}
              />
              {model.propagationModel === 'hata' && (
                <SelectField
                  label="Environment" value={model.environment} disabled={model.autoDetectEnvironment}
                  onChange={v => setModel(m => ({ ...m, environment: v as HataEnvironment }))}
                  options={[{ value: 'urban', label: 'Urban' }, { value: 'suburban', label: 'Suburban' }, { value: 'open', label: 'Open/Rural' }]}
                />
              )}
              {model.propagationModel === 'cost231-hata' && (
                <SelectField
                  label="City Type" value={model.cityType} disabled={model.autoDetectEnvironment}
                  onChange={v => setModel(m => ({ ...m, cityType: v as Cost231CityType }))}
                  options={[{ value: 'medium', label: 'Medium City / Suburban' }, { value: 'metropolitan', label: 'Metropolitan Center' }]}
                />
              )}
              {(model.propagationModel === 'hata' || model.propagationModel === 'cost231-hata' || model.propagationModel === 'walfisch-ikegami') && (
                <label className="flex items-center gap-2 text-xs text-nms-text mt-5" title="Looks up the site's real ESA WorldCover land-cover class instead of defaulting to urban/medium — a coarse built-up-vs-not convention, not a precise urban/suburban/open classification">
                  <input
                    type="checkbox" checked={model.autoDetectEnvironment}
                    onChange={e => setModel(m => ({ ...m, autoDetectEnvironment: e.target.checked }))} className="nms-checkbox"
                  />
                  Auto-detect from real land cover (ESA WorldCover)
                </label>
              )}
              {model.propagationModel === 'close-in' && !model.useTerrainData && (
                <label className="flex items-center gap-2 text-xs text-nms-text mt-5">
                  <input type="checkbox" checked={model.isLineOfSight} onChange={e => setModel(m => ({ ...m, isLineOfSight: e.target.checked }))} className="nms-checkbox" />
                  Line of sight (unchecked = NLOS, more conservative)
                </label>
              )}
              {model.propagationModel === 'log-distance' && (
                <SelectField
                  label="Environment Preset" value={model.logDistanceEnvironment}
                  onChange={v => setModel(m => ({ ...m, logDistanceEnvironment: v as LogDistanceEnvironment }))}
                  options={[
                    { value: 'free-space', label: 'Free Space (n=2.0)' },
                    { value: 'urban', label: 'Urban (n=3.0)' },
                    { value: 'dense-urban', label: 'Dense/Shadowed Urban (n=4.0)' },
                    { value: 'indoor', label: 'Indoor LOS (n=1.7)' },
                    { value: 'rural', label: 'Rural (n=3.5, unverified)' },
                    { value: 'suburban', label: 'Suburban (n=3.0, unverified)' },
                  ]}
                />
              )}
              {(model.propagationModel === 'close-in' || model.propagationModel === 'log-distance') && (
                <NumField
                  label="Path-Loss Exponent Override" value={model.pathLossExponent} onChange={v => setModel(m => ({ ...m, pathLossExponent: v }))}
                  placeholder={model.propagationModel === 'close-in' ? 'auto (2.0 LOS / 3.1 NLOS)' : 'auto (from preset)'}
                />
              )}
              {model.propagationModel === 'walfisch-ikegami' && (
                <>
                  <SelectField
                    label="LOS / NLOS" value={model.walfischIkegamiMode}
                    onChange={v => setModel(m => ({ ...m, walfischIkegamiMode: v as WalfischIkegamiMode }))}
                    options={[
                      { value: 'los', label: 'LOS (street canyon)' },
                      { value: 'nlos', label: 'NLOS (rooftop diffraction)' },
                    ]}
                  />
                  <SelectField
                    label="City Type" value={model.cityType} disabled={model.autoDetectEnvironment}
                    onChange={v => setModel(m => ({ ...m, cityType: v as Cost231CityType }))}
                    options={[{ value: 'medium', label: 'Medium City / Suburban' }, { value: 'metropolitan', label: 'Metropolitan Center' }]}
                  />
                  {model.walfischIkegamiMode === 'nlos' && (
                    <>
                      <NumField label="Building/Rooftop Height" value={model.buildingHeightM} onChange={v => setModel(m => ({ ...m, buildingHeightM: v }))} unit="m" placeholder="required, > RX height" />
                      <NumField label="Street Width" value={model.streetWidthM} onChange={v => setModel(m => ({ ...m, streetWidthM: v }))} unit="m" placeholder="auto (building separation / 2)" />
                      <NumField label="Building Separation" value={model.buildingSeparationM} onChange={v => setModel(m => ({ ...m, buildingSeparationM: v }))} unit="m" placeholder="auto (35, COST-231 range is 20-50)" />
                      <NumField label="Street Orientation" value={model.streetOrientationDeg} onChange={v => setModel(m => ({ ...m, streetOrientationDeg: v }))} unit="deg" placeholder="auto (90)" />
                    </>
                  )}
                </>
              )}
              {model.propagationModel === 'itm' && (
                <>
                  <SelectField
                    label="Radio Climate" value={model.radioClimate}
                    onChange={v => setModel(m => ({ ...m, radioClimate: v as ItmRadioClimate }))}
                    options={[
                      { value: 'equatorial', label: 'Equatorial' },
                      { value: 'continental-subtropical', label: 'Continental Subtropical' },
                      { value: 'maritime-subtropical', label: 'Maritime Subtropical' },
                      { value: 'desert', label: 'Desert' },
                      { value: 'continental-temperate', label: 'Continental Temperate (default)' },
                      { value: 'maritime-temperate-land', label: 'Maritime Temperate, Over Land' },
                      { value: 'maritime-temperate-sea', label: 'Maritime Temperate, Over Sea' },
                    ]}
                  />
                  <SelectField
                    label="Polarization" value={model.polarization}
                    onChange={v => setModel(m => ({ ...m, polarization: v as ItmPolarization }))}
                    options={[{ value: 'horizontal', label: 'Horizontal' }, { value: 'vertical', label: 'Vertical' }]}
                  />
                  <SelectField
                    label="Mode of Variability" value={model.modeOfVariability}
                    onChange={v => setModel(m => ({ ...m, modeOfVariability: v as ItmVariabilityMode }))}
                    options={[
                      { value: 'single-message', label: 'Single Message' },
                      { value: 'accidental', label: 'Accidental' },
                      { value: 'mobile', label: 'Mobile' },
                      { value: 'broadcast', label: 'Broadcast (default)' },
                    ]}
                  />
                  <NumField label="Time Variability" value={model.timePercent} onChange={v => setModel(m => ({ ...m, timePercent: v }))} unit="%" placeholder="auto (50)" />
                  <NumField label="Location Variability" value={model.locationPercent} onChange={v => setModel(m => ({ ...m, locationPercent: v }))} unit="%" placeholder="auto (50)" />
                  <NumField label="Situation Variability" value={model.situationPercent} onChange={v => setModel(m => ({ ...m, situationPercent: v }))} unit="%" placeholder="auto (50)" />
                  <NumField label="Ground Conductivity" value={model.groundConductivity} onChange={v => setModel(m => ({ ...m, groundConductivity: v }))} unit="S/m" placeholder="auto (0.005, average ground)" />
                  <NumField label="Ground Permittivity" value={model.groundPermittivity} onChange={v => setModel(m => ({ ...m, groundPermittivity: v }))} placeholder="auto (15, average ground)" />
                  <NumField label="Surface Refractivity" value={model.surfaceRefractivityN0} onChange={v => setModel(m => ({ ...m, surfaceRefractivityN0: v }))} unit="N-units" placeholder="auto (301)" />
                </>
              )}
              <label className={`flex items-center gap-2 text-xs mt-5 ${model.propagationModel === 'itm' ? 'text-nms-text-dim' : 'text-nms-text'}`}>
                <input
                  type="checkbox" checked={model.useTerrainData} disabled={model.propagationModel === 'itm'}
                  onChange={e => setModel(m => ({ ...m, useTerrainData: e.target.checked }))} className="nms-checkbox"
                />
                {model.propagationModel === 'itm' ? 'Real terrain required by ITM (always on)' : 'Use real terrain (line-of-sight/diffraction)'}
              </label>
            </div>
            <p className="text-[11px] text-nms-text-dim">
              Terrain data is fetched by the server on demand and cached — the first calculation over a new area may take a little longer while elevation tiles download.
              {model.propagationModel === 'close-in' && ' With terrain enabled, Close-In automatically picks the LOS/NLOS exponent from the real terrain check instead of the checkbox above.'}
              {model.propagationModel === 'itm' && ' ITM (NTIA Longley-Rice) computes diffraction/troposcatter internally from this same terrain profile — the separate Deygout diffraction figure shown elsewhere is diagnostic only for this model, not added on top.'}
            </p>
          </div>

          <div className="nms-card space-y-3">
            <p className="text-sm font-semibold text-nms-text">Propagation &amp; Grid</p>
            <div className="grid grid-cols-3 gap-3">
              <NumField label="Building Loss" value={propagation.buildingLossDb} onChange={setPropagationField('buildingLossDb')} unit="dB" placeholder="0" />
              <NumField label="Foliage Loss" value={propagation.foliageLossDb} onChange={setPropagationField('foliageLossDb')} unit="dB" placeholder="0" />
              <NumField label="Misc Loss" value={propagation.miscLossDb} onChange={setPropagationField('miscLossDb')} unit="dB" placeholder="0" />
              <NumField label="UE Antenna Gain" value={propagation.ueAntennaGainDbi} onChange={setPropagationField('ueAntennaGainDbi')} unit="dBi" placeholder="0" />
              <NumField label="Receiver Height" value={propagation.receiverHeightM} onChange={setPropagationField('receiverHeightM')} unit="m" placeholder="1.5" />
              <NumField label="Radius" value={grid.radiusM} onChange={setGridField('radiusM')} unit="m" />
              <NumField label="Grid Resolution" value={grid.resolution} onChange={setGridField('resolution')} unit="cells/side" />
              <NumField label="Min Acceptable Signal" value={grid.minAcceptableSignalDbm} onChange={setGridField('minAcceptableSignalDbm')} unit="dBm" placeholder="-100" />
            </div>
            <p className="text-[11px] text-nms-text-dim">
              Min Acceptable Signal only applies if you've drawn a target area on the map — it's used to compute the TX power required to cover it.
            </p>
          </div>

          <button onClick={submit} disabled={loading} className="nms-btn-primary w-full">
            {loading
              ? 'Calculating…'
              : activeProject && activeProject.sites.length >= 2
                ? `Calculate Combined Coverage (${activeProject.sites.length} radios)`
                : 'Calculate Coverage'}
          </button>
        </div>

        <div className="space-y-4 w-full">
          {res?.ok && res.result?.coverageRequirement && (
            <div className="nms-card space-y-2 border-nms-accent/30">
              <p className="text-sm font-semibold text-nms-text mb-1">Coverage Requirement</p>
              <ResultLine label="Required TX Power" value={res.result.coverageRequirement.requiredTxPowerDbm} unit="dBm" />
              <ResultLine label="Limiting Distance" value={res.result.coverageRequirement.limitingDistanceM} unit="m" />
              <p className="text-[11px] text-nms-text-dim">
                Limited by the point at ({res.result.coverageRequirement.limitingPoint.lat.toFixed(5)}, {res.result.coverageRequirement.limitingPoint.lon.toFixed(5)}),
                sampled from {res.result.coverageRequirement.pointsSampled} grid points inside the drawn area, against a threshold of {res.result.coverageRequirement.thresholdDbm} dBm.
              </p>
            </div>
          )}

          {inPolygonStats && (
            <div className="nms-card space-y-2">
              <p className="text-sm font-semibold text-nms-text mb-1">Predicted Signal Inside Drawn Area</p>
              <ResultLine label="Minimum" value={inPolygonStats.min} unit="dBm" />
              <ResultLine label="Average" value={inPolygonStats.avg} unit="dBm" />
              <ResultLine label="Maximum" value={inPolygonStats.max} unit="dBm" />
            </div>
          )}

          {activeResult && !activeResult.ok && (
            <div className="nms-card border-red-500/30">
              <p className="text-sm text-red-400">{activeResult.error?.reason}</p>
              {activeResult.error?.missingInputs && activeResult.error.missingInputs.length > 0 && (
                <p className="text-xs text-nms-text-dim mt-1">Missing: {activeResult.error.missingInputs.join(', ')}</p>
              )}
            </div>
          )}

          {activeResult && activeResult.calculation.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                {interferenceResult?.ok
                  ? 'Calculation Model (shown for the strongest-predicted cell across all radios as a representative example)'
                  : 'Calculation Model (shown for the strongest-predicted cell as a representative example)'}
              </p>
              {activeResult.calculation.map((eq, i) => <EquationDisclosure key={i} eq={eq} />)}
            </div>
          )}

          {activeResult && <AssumptionsWarnings res={activeResult} />}
        </div>
      </div>
    </div>
  );
}
