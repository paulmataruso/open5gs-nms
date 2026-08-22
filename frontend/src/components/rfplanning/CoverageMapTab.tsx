import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw';
import 'leaflet-draw/dist/leaflet.draw.css';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import { Crosshair, Trash2, FolderOpen, Save, Plus, Scale, Radio as RadioIcon, Target, FileDown } from 'lucide-react';
import toast from 'react-hot-toast';
import { rfPlanningApi, rfPlanningProjectsApi } from '../../api/rfPlanning';
import type {
  CoverageGridInput, CoverageGridResult, CalculationResult, LatLon,
  PropagationModel, HataEnvironment, Cost231CityType,
  RfPlanningProject, RfPlanningSite, SiteComparisonResult,
  InterferenceGridResult, CalibrationResult,
} from '../../api/rfPlanning';
import { NumField, SelectField, EquationDisclosure, AssumptionsWarnings, ResultLine } from './shared';

// Leaflet's default marker icon paths break under bundlers (the CSS
// references relative image URLs that don't resolve the way Leaflet
// expects) — this is the standard fix: point the default icon at the
// bundler-resolved asset URLs instead.
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({ iconUrl: markerIcon, iconRetinaUrl: markerIcon2x, shadowUrl: markerShadow });

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
    useTerrainData: boolean; isLineOfSight: boolean; pathLossExponent: string;
  }>({
    propagationModel: 'fspl', environment: 'urban', cityType: 'medium',
    useTerrainData: false, isLineOfSight: false, pathLossExponent: '',
  });
  const [grid, setGrid] = useState({ radiusM: '2000', resolution: '40', minAcceptableSignalDbm: '-100' });

  const [polygon, setPolygon] = useState<LatLon[]>([]);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<CalculationResult<CoverageGridResult> | null>(null);

  const [projects, setProjects] = useState<RfPlanningProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState('');
  const [comparison, setComparison] = useState<SiteComparisonResult[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const activeProject = projects.find(p => p.id === activeProjectId) ?? null;

  const [activeHeatmap, setActiveHeatmap] = useState<'coverage' | 'interference'>('coverage');
  const [interferenceResult, setInterferenceResult] = useState<CalculationResult<InterferenceGridResult> | null>(null);
  const [computingInterference, setComputingInterference] = useState(false);

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

    const marker = L.marker([Number(site.lat) || 0, Number(site.lon) || 0], { draggable: true }).addTo(map);
    marker.on('dragend', () => {
      const ll = marker.getLatLng();
      setSite(s => ({ ...s, lat: ll.lat.toFixed(6), lon: ll.lng.toFixed(6) }));
    });
    siteMarkerRef.current = marker;

    map.on('click', (e: L.LeafletMouseEvent) => {
      setSite(s => ({ ...s, lat: e.latlng.lat.toFixed(6), lon: e.latlng.lng.toFixed(6) }));
    });

    const drawnItems = new L.FeatureGroup().addTo(map);
    drawnItemsRef.current = drawnItems;

    const drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#38bdf8' } },
        polyline: false, rectangle: false, circle: false, circlemarker: false, marker: false,
      },
      edit: { featureGroup: drawnItems, remove: true },
    });
    map.addControl(drawControl);

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

    const cone = L.polygon(boresightCone(lat, lon, azimuth, beamwidth, radiusM), {
      color: '#38bdf8', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.08,
    }).addTo(mapRef.current);
    coneLayerRef.current = cone;
  }, [site.lat, site.lon, antenna.azimuthDeg, antenna.horizontalBeamwidthDeg, grid.radiusM]);

  // Other saved sites in the active project — shown as a distinct color so
  // candidate placements can be visually compared against the site
  // currently being edited (blue).
  useEffect(() => {
    if (!mapRef.current || !projectSitesGroupRef.current) return;
    projectSitesGroupRef.current.clearLayers();
    if (!activeProject) return;
    for (const s of activeProject.sites) {
      L.polygon(boresightCone(s.siteLat, s.siteLon, s.azimuthDeg, s.horizontalBeamwidthDeg, 2000), {
        color: '#a855f7', weight: 1, fillColor: '#a855f7', fillOpacity: 0.1,
      }).bindTooltip(s.name).addTo(projectSitesGroupRef.current);
      L.circleMarker([s.siteLat, s.siteLon], { radius: 5, color: '#a855f7', fillColor: '#a855f7', fillOpacity: 1 })
        .bindTooltip(s.name).addTo(projectSitesGroupRef.current);
    }
  }, [activeProject]);

  // Heatmap render — redraws whenever a new calculation result comes back.
  useEffect(() => {
    if (!mapRef.current || !heatmapGroupRef.current) return;
    heatmapGroupRef.current.clearLayers();
    if (activeHeatmap !== 'coverage' || !res?.ok || !res.result) return;

    const { cells, rows, bounds } = res.result;
    const radiusM = Number(grid.radiusM);
    const stepM = (2 * radiusM) / rows;
    const metersPerDegLat = (2 * Math.PI * EARTH_RADIUS_M) / 360;
    const metersPerDegLon = metersPerDegLat * Math.cos((Number(site.lat) * Math.PI) / 180);
    const halfLat = (stepM / 2) / metersPerDegLat;
    const halfLon = (stepM / 2) / metersPerDegLon;

    for (const cell of cells) {
      L.rectangle(
        [[cell.lat - halfLat, cell.lon - halfLon], [cell.lat + halfLat, cell.lon + halfLon]],
        {
          renderer: canvasRendererRef.current ?? undefined,
          color: dbmToColor(cell.totalReceivedPowerDbm),
          weight: 0,
          fillColor: dbmToColor(cell.totalReceivedPowerDbm),
          fillOpacity: 0.55,
        },
      ).addTo(heatmapGroupRef.current);
    }

    if (!hasFitBoundsRef.current) {
      mapRef.current.fitBounds([[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]]);
      hasFitBoundsRef.current = true;
    }
  }, [res, grid.radiusM, site.lat, activeHeatmap]);

  // SINR heatmap render — a separate layer/color-scale, toggled on by
  // "Compute Interference/SINR" rather than shown alongside the single-
  // site coverage heatmap.
  useEffect(() => {
    if (!mapRef.current || !interferenceGroupRef.current) return;
    interferenceGroupRef.current.clearLayers();
    if (activeHeatmap !== 'interference' || !interferenceResult?.ok || !interferenceResult.result) return;

    const { cells, rows, cols, bounds } = interferenceResult.result;
    const halfLat = (bounds.maxLat - bounds.minLat) / rows / 2;
    const halfLon = (bounds.maxLon - bounds.minLon) / cols / 2;

    for (const cell of cells) {
      if (cell.sinrDb == null) continue;
      L.rectangle(
        [[cell.lat - halfLat, cell.lon - halfLon], [cell.lat + halfLat, cell.lon + halfLon]],
        {
          renderer: canvasRendererRef.current ?? undefined,
          color: sinrToColor(cell.sinrDb), weight: 0, fillColor: sinrToColor(cell.sinrDb), fillOpacity: 0.55,
        },
      ).addTo(interferenceGroupRef.current);
    }

    mapRef.current.fitBounds([[bounds.minLat, bounds.minLon], [bounds.maxLat, bounds.maxLon]]);
  }, [interferenceResult, activeHeatmap]);

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
    environment: model.propagationModel === 'hata' ? model.environment : undefined,
    cityType: model.propagationModel === 'cost231-hata' ? model.cityType : undefined,
    useTerrainData: model.useTerrainData,
    isLineOfSight: model.propagationModel === 'close-in' && !model.useTerrainData ? model.isLineOfSight : undefined,
    pathLossExponent: model.propagationModel === 'close-in' && model.pathLossExponent ? Number(model.pathLossExponent) : undefined,
  });

  const submit = async () => {
    setLoading(true);
    setRes(null);
    setActiveHeatmap('coverage');
    hasFitBoundsRef.current = false;
    try {
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

  const loadSite = (s: RfPlanningSite) => {
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
      useTerrainData: !!s.useTerrainData,
      isLineOfSight: !!s.isLineOfSight,
      pathLossExponent: s.pathLossExponent != null ? String(s.pathLossExponent) : '',
    });
    toast.success(`Loaded "${s.name}"`);
  };

  const deleteSite = async (siteId: string) => {
    if (!activeProject) return;
    try {
      const updated = await rfPlanningProjectsApi.update(activeProject.id, { sites: activeProject.sites.filter(s => s.id !== siteId) });
      setProjects(ps => ps.map(p => (p.id === updated.id ? updated : p)));
    } catch { toast.error('Failed to delete site'); }
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

  const computeInterference = async () => {
    if (!activeProject) return;
    if (activeProject.sites.length < 2) { toast.error('Add at least 2 sites to this project first'); return; }
    setComputingInterference(true);
    setInterferenceResult(null);
    try {
      const result = await rfPlanningProjectsApi.interference(activeProject.id, { radiusM: Number(grid.radiusM), resolution: Number(grid.resolution) });
      setInterferenceResult(result);
      setActiveHeatmap('interference');
      if (!result.ok) toast.error(result.error?.reason || 'Interference calculation failed');
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Interference calculation failed');
    } finally {
      setComputingInterference(false);
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

  return (
    <div className="space-y-6">
      <div className="nms-card space-y-3">
        <p className="text-sm font-semibold text-nms-text">Project</p>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="nms-input flex-1 min-w-[200px]" value={activeProjectId} onChange={e => { setActiveProjectId(e.target.value); setComparison(null); }}>
            <option value="">— No project selected (unsaved) —</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.sites.length} site{p.sites.length === 1 ? '' : 's'})</option>)}
          </select>
          <button type="button" onClick={createProject} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <Plus className="w-3.5 h-3.5" /> New Project
          </button>
          <button type="button" onClick={saveAsSite} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
            <Save className="w-3.5 h-3.5" /> Save Current as Site
          </button>
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

        {activeProject && (
          <div className="space-y-2 pt-2 border-t border-nms-border">
            <button type="button" onClick={computeInterference} disabled={computingInterference} className="nms-btn-ghost flex items-center gap-1.5 text-xs border border-nms-border">
              <RadioIcon className="w-3.5 h-3.5" /> {computingInterference ? 'Computing…' : 'Compute Interference / SINR for Project'}
            </button>
            <p className="text-[11px] text-nms-text-dim">
              For every site saved in this project, computes each grid point's serving site and Signal-to-Interference-plus-Noise Ratio (every other site treated as an interferer) — needs at least 2 saved sites.
            </p>
            {interferenceResult?.ok && interferenceResult.result && (
              <div className="flex items-center gap-4 flex-wrap text-[11px] text-nms-text-dim">
                {SINR_LEGEND.map(l => (
                  <span key={l.label} className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
                    {l.label} ({l.range})
                  </span>
                ))}
              </div>
            )}
            {interferenceResult && !interferenceResult.ok && (
              <p className="text-xs text-red-400">{interferenceResult.error?.reason}</p>
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
            Site &amp; Coverage Map — click or drag the pin to place your radio, then use the polygon tool (top-right) to draw the area you want covered
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
        <div ref={mapContainerRef} style={{ height: 520 }} className="rounded-lg overflow-hidden border border-nms-border" />
        <div className="flex items-center gap-4 flex-wrap text-[11px] text-nms-text-dim">
          {LEGEND.map(l => (
            <span key={l.label} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: l.color }} />
              {l.label} ({l.range})
            </span>
          ))}
          {activeProject && activeProject.sites.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ backgroundColor: '#a855f7' }} />
              Other saved sites in this project
            </span>
          )}
          <span className="ml-auto">
            {polygon.length >= 3 ? `Target area drawn (${polygon.length} vertices)` : 'No target area drawn yet'}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-4">
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
                onChange={v => setModel(m => ({ ...m, propagationModel: v as PropagationModel }))}
                options={[
                  { value: 'fspl', label: 'Free-Space Path Loss' },
                  { value: 'hata', label: 'Hata (150-1500 MHz, 30-200m towers)' },
                  { value: 'cost231-hata', label: 'COST-231-Hata (1500-2000 MHz, 30-200m towers)' },
                  { value: 'close-in', label: 'Close-In (any frequency/height — CBRS/small cell)' },
                ]}
              />
              {model.propagationModel === 'hata' && (
                <SelectField
                  label="Environment" value={model.environment}
                  onChange={v => setModel(m => ({ ...m, environment: v as HataEnvironment }))}
                  options={[{ value: 'urban', label: 'Urban' }, { value: 'suburban', label: 'Suburban' }, { value: 'open', label: 'Open/Rural' }]}
                />
              )}
              {model.propagationModel === 'cost231-hata' && (
                <SelectField
                  label="City Type" value={model.cityType}
                  onChange={v => setModel(m => ({ ...m, cityType: v as Cost231CityType }))}
                  options={[{ value: 'medium', label: 'Medium City / Suburban' }, { value: 'metropolitan', label: 'Metropolitan Center' }]}
                />
              )}
              {model.propagationModel === 'close-in' && !model.useTerrainData && (
                <label className="flex items-center gap-2 text-xs text-nms-text mt-5">
                  <input type="checkbox" checked={model.isLineOfSight} onChange={e => setModel(m => ({ ...m, isLineOfSight: e.target.checked }))} className="nms-checkbox" />
                  Line of sight (unchecked = NLOS, more conservative)
                </label>
              )}
              {model.propagationModel === 'close-in' && (
                <NumField label="Path-Loss Exponent Override" value={model.pathLossExponent} onChange={v => setModel(m => ({ ...m, pathLossExponent: v }))} placeholder="auto (2.0 LOS / 3.1 NLOS)" />
              )}
              <label className="flex items-center gap-2 text-xs text-nms-text mt-5">
                <input type="checkbox" checked={model.useTerrainData} onChange={e => setModel(m => ({ ...m, useTerrainData: e.target.checked }))} className="nms-checkbox" />
                Use real terrain (line-of-sight/diffraction)
              </label>
            </div>
            <p className="text-[11px] text-nms-text-dim">
              Terrain data is fetched by the server on demand and cached — the first calculation over a new area may take a little longer while elevation tiles download.
              {model.propagationModel === 'close-in' && ' With terrain enabled, Close-In automatically picks the LOS/NLOS exponent from the real terrain check instead of the checkbox above.'}
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
            {loading ? 'Calculating…' : 'Calculate Coverage'}
          </button>
        </div>

        <div className="space-y-4">
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

          {res && !res.ok && (
            <div className="nms-card border-red-500/30">
              <p className="text-sm text-red-400">{res.error?.reason}</p>
              {res.error?.missingInputs && res.error.missingInputs.length > 0 && (
                <p className="text-xs text-nms-text-dim mt-1">Missing: {res.error.missingInputs.join(', ')}</p>
              )}
            </div>
          )}

          {res && res.calculation.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">
                Calculation Model (shown for the strongest-predicted cell as a representative example)
              </p>
              {res.calculation.map((eq, i) => <EquationDisclosure key={i} eq={eq} />)}
            </div>
          )}

          {res && <AssumptionsWarnings res={res} />}
        </div>
      </div>
    </div>
  );
}
