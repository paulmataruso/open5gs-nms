import { useEffect, useRef, useCallback } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  groupBySite,
  type PlanningRadio, type PlanningBuilding, type CellResult, type QualityEntry,
} from '../../api/rfSimulation';

// The planning map.
//
// Interaction model, which is the part that matters most: the map is MODAL and
// says so. Entering "place" mode swaps the cursor to a crosshair, shows a hint,
// and the next click drops a site; Escape cancels. Clicking a site marker, a
// sector wedge or a building SELECTS it, which switches the inspector on the
// right to that thing — never a popup, because a popup covers the very geometry
// you are editing and has to be dismissed before you can see the result.
//
// Rendering notes:
//   * Panes with explicit z-indices, so layer order is declared rather than
//     emerging from insertion order: heatmap < buildings < rays < sectors <
//     markers. Without this, re-running a simulation can silently reorder the
//     map depending on which effect happened to fire first.
//   * Rays go on a CANVAS renderer. A 400 m / 60-ray simulation emits ~960
//     segments per sector, and as individual SVG paths that is thousands of DOM
//     nodes — it stutters on pan and drag. Canvas keeps it smooth.
//   * Sector wedges stay SVG. There are at most a handful, and an SVG path
//     only captures clicks where the shape actually is, so a wedge sitting over
//     a building does not swallow that building's clicks the way a
//     full-viewport interactive canvas would.
//   * invalidateSize() is wired to a ResizeObserver: Leaflet measures its
//     container once and otherwise only recomputes on a window resize, which
//     an embedded panel does not trigger. Without this the tiles come back
//     partially loaded whenever the surrounding layout shifts.

export type MapMode = 'inspect' | 'place';

export type Selection =
  | { kind: 'none' }
  | { kind: 'site'; id: string }
  | { kind: 'sector'; id: string }
  | { kind: 'building'; id: string };

export interface HeatmapOverlay {
  dataUrl: string;
  bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number };
}

export interface PlanningMapProps {
  radios: PlanningRadio[];
  buildings: PlanningBuilding[];
  results: CellResult[] | null;
  quality: QualityEntry[] | null;
  heatmap: HeatmapOverlay | null;
  selection: Selection;
  mode: MapMode;
  radiusM: number;
  layers: { heatmap: boolean; rays: boolean; sectors: boolean; buildings: boolean };
  onPlace: (latitude: number, longitude: number) => void;
  onSelect: (selection: Selection) => void;
  onMoveSite: (siteId: string, latitude: number, longitude: number) => void;
  onCancelMode: () => void;
  onViewportChange?: (bounds: { minLon: number; minLat: number; maxLon: number; maxLat: number }) => void;
}

/** Quality classes to a fill colour. Data colours, fixed across UI themes. */
const QUALITY_FILL: Record<string, string> = {
  good: '#059669',
  fair: '#22c55e',
  poor: '#f59e0b',
  unusable: '#e11d48',
};

const PANES = {
  heatmap: { name: 'rf-heatmap', z: 350 },
  buildings: { name: 'rf-buildings', z: 360 },
  rays: { name: 'rf-rays', z: 370 },
} as const;

function siteIcon(sectorCount: number, selected: boolean): L.DivIcon {
  // Inline SVG rather than an image asset: it scales, needs no network round
  // trip, and the selected state is a style change rather than a second file.
  const size = selected ? 20 : 16;
  const label = sectorCount > 1 ? `<span style="font:600 9px system-ui;color:#0c4a6e">${sectorCount}</span>` : '';
  return L.divIcon({
    className: 'rf-radio-marker',
    html:
      `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;` +
      `border-radius:50%;background:${selected ? '#f8fafc' : '#0ea5e9'};` +
      `border:3px solid ${selected ? '#0ea5e9' : '#0c4a6e'};box-shadow:0 0 0 2px rgba(0,0,0,.35);">${label}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/**
 * How far below boresight the faint outer wedge is drawn.
 *
 * A panel's rated beamwidth is its 3 dB (half-power) width, so drawing only
 * that leaves 55° of apparent emptiness between the sectors of a standard
 * 3 × 65° site on 120° spacing — which is NOT what the engine computes. At the
 * 60° crossover each neighbour is about 10 dB down and still the serving cell,
 * and the heatmap shows continuous coverage there. Drawing the −10 dB contour
 * as well makes the wedges meet, so the picture stops implying holes the
 * simulation does not have.
 */
const OUTER_CONTOUR_DB = 10;

/**
 * Angular width of the contour `dropDb` below boresight.
 *
 * Inverts the engine's own roll-off (12·(θ/bw)², antenna-pattern.ts), so this
 * outline can never imply a shape the simulation does not produce. Mirrors
 * patternWidthDeg() in domain/rf/antenna-catalog.ts, which is the tested copy.
 */
function patternWidthDeg(beamWidthDeg: number, dropDb: number): number {
  return Math.min(360, 2 * beamWidthDeg * Math.sqrt(dropDb / 12));
}

/** Sector wedge polygon for a radio's azimuth and a given angular width. */
function sectorWedge(radio: PlanningRadio, radiusM: number, widthDeg: number): L.LatLngExpression[] {
  const points: L.LatLngExpression[] = [[radio.latitude, radio.longitude]];
  const start = radio.azimuthDeg - widthDeg / 2;
  const steps = Math.max(24, Math.round(widthDeg / 3));
  const mPerDegLat = 111132.92;
  const mPerDegLon = 111320 * Math.cos((radio.latitude * Math.PI) / 180);
  for (let i = 0; i <= steps; i++) {
    const bearing = ((start + (widthDeg * i) / steps) * Math.PI) / 180;
    points.push([
      radio.latitude + (Math.cos(bearing) * radiusM) / mPerDegLat,
      radio.longitude + (Math.sin(bearing) * radiusM) / mPerDegLon,
    ]);
  }
  return points;
}

export function PlanningMap(props: PlanningMapProps) {
  const {
    radios, buildings, results, quality, heatmap, selection, mode, radiusM, layers,
    onPlace, onSelect, onMoveSite, onCancelMode, onViewportChange,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const rayCanvasRef = useRef<L.Canvas | null>(null);
  const buildingCanvasRef = useRef<L.Canvas | null>(null);
  const heatmapGroupRef = useRef<L.LayerGroup | null>(null);
  const rayGroupRef = useRef<L.LayerGroup | null>(null);
  const sectorGroupRef = useRef<L.LayerGroup | null>(null);
  const buildingGroupRef = useRef<L.LayerGroup | null>(null);
  const markerGroupRef = useRef<L.LayerGroup | null>(null);
  const fittedRef = useRef(false);

  // Handlers change every render; keep them in refs so the map's own listeners
  // can be attached once instead of being torn down and rebuilt constantly.
  const handlers = useRef({ onPlace, onSelect, onMoveSite, onCancelMode, onViewportChange, mode });
  handlers.current = { onPlace, onSelect, onMoveSite, onCancelMode, onViewportChange, mode };

  // ── map construction, once ────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { preferCanvas: true, zoomControl: true })
      .setView([43.3753, -72.1804], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    for (const pane of Object.values(PANES)) {
      map.createPane(pane.name);
      const element = map.getPane(pane.name);
      if (element) element.style.zIndex = String(pane.z);
    }
    rayCanvasRef.current = L.canvas({ padding: 0.3, pane: PANES.rays.name });
    buildingCanvasRef.current = L.canvas({ padding: 0.3, pane: PANES.buildings.name });

    heatmapGroupRef.current = L.layerGroup().addTo(map);
    buildingGroupRef.current = L.layerGroup().addTo(map);
    rayGroupRef.current = L.layerGroup().addTo(map);
    sectorGroupRef.current = L.layerGroup().addTo(map);
    markerGroupRef.current = L.layerGroup().addTo(map);

    map.on('click', event => {
      const current = handlers.current;
      if (current.mode === 'place') {
        current.onPlace(event.latlng.lat, event.latlng.lng);
      } else {
        // Clicking empty map clears the selection — the cheap way back out.
        current.onSelect({ kind: 'none' });
      }
    });

    const emitViewport = () => {
      const bounds = map.getBounds();
      handlers.current.onViewportChange?.({
        minLon: bounds.getWest(), minLat: bounds.getSouth(),
        maxLon: bounds.getEast(), maxLat: bounds.getNorth(),
      });
    };
    map.on('moveend zoomend', emitViewport);
    emitViewport();

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ── Escape cancels placement ──────────────────────────────────────────────
  useEffect(() => {
    if (mode !== 'place') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCancelMode(); }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [mode, onCancelMode]);

  // ── cursor feedback for the active mode ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const container = map.getContainer();
    const previous = container.style.cursor;
    container.style.cursor = mode === 'place' ? 'crosshair' : '';
    return () => { container.style.cursor = previous; };
  }, [mode]);

  // ── keep Leaflet's idea of its own size honest ────────────────────────────
  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => mapRef.current?.invalidateSize());
    });
    observer.observe(element);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, []);

  // ── coverage heatmap ──────────────────────────────────────────────────────
  useEffect(() => {
    const group = heatmapGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.heatmap || !heatmap) return;
    L.imageOverlay(
      heatmap.dataUrl,
      [[heatmap.bounds.minLat, heatmap.bounds.minLon], [heatmap.bounds.maxLat, heatmap.bounds.maxLon]],
      { interactive: false, pane: PANES.heatmap.name },
    ).addTo(group);
  }, [heatmap, layers.heatmap]);

  // ── buildings ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const group = buildingGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.buildings) return;
    const byId = new Map((quality ?? []).map(q => [q.buildingId, q]));
    for (const building of buildings) {
      if (building.ring.length < 3) continue;
      const entry = byId.get(building.id);
      const demand = building.demandWeight + building.residentialDemand;
      const selected = selection.kind === 'building' && selection.id === building.id;
      const polygon = L.polygon(building.ring.map(([lon, lat]) => [lat, lon] as L.LatLngTuple), {
        renderer: buildingCanvasRef.current ?? undefined,
        pane: PANES.buildings.name,
        // Unsimulated buildings are neutral grey; after a run they take their
        // measured quality colour, so the map answers "who is served" directly.
        color: selected ? '#f8fafc' : entry ? QUALITY_FILL[entry.qualityClass] : '#64748b',
        weight: selected ? 2 : 1,
        fillColor: entry ? QUALITY_FILL[entry.qualityClass] : '#475569',
        fillOpacity: entry ? 0.45 : 0.18,
      });
      polygon.on('click', event => {
        L.DomEvent.stopPropagation(event as unknown as Event);
        handlers.current.onSelect({ kind: 'building', id: building.id });
      });
      polygon
        .bindTooltip(
          entry
            ? `${building.id}<br/>RSRP ${entry.rsrpDbm} dBm · SINR ${entry.sinrDb} dB · RSRQ ${entry.rsrqDb} dB` +
              `<br/>${entry.qualityClass}${entry.interferenceLimited ? ' · interference-limited' : ''}` +
              `<br/>demand ${demand.toFixed(0)}`
            : `${building.id}<br/>demand ${demand.toFixed(0)}${building.heightM ? ` · ${building.heightM} m` : ''}`,
          { sticky: true },
        )
        .addTo(group);
    }
  }, [buildings, quality, layers.buildings, selection]);

  // ── ray segments ──────────────────────────────────────────────────────────
  useEffect(() => {
    const group = rayGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.rays || !results) return;
    for (const cell of results) {
      if (!cell.rays) continue;
      for (const feature of cell.rays.features) {
        const [a, b] = feature.geometry.coordinates;
        L.polyline([[a[1], a[0]], [b[1], b[0]]], {
          renderer: rayCanvasRef.current ?? undefined,
          pane: PANES.rays.name,
          color: feature.properties.color,
          weight: feature.properties.is_terminal ? 3 : 2,
          opacity: 0.85,
          interactive: false, // thousands of segments; hit-testing them all is wasteful
        }).addTo(group);
      }
    }
  }, [results, layers.rays]);

  // ── sector wedges, clickable ──────────────────────────────────────────────
  useEffect(() => {
    const group = sectorGroupRef.current;
    if (!group) return;
    group.clearLayers();
    if (!layers.sectors) return;
    for (const radio of radios) {
      const isSector = selection.kind === 'sector' && selection.id === radio.id;
      const isSite = selection.kind === 'site' && selection.id === radio.siteId;
      const highlighted = isSector || isSite;
      // Dim the rest when one sector is being worked on, so the thing you are
      // editing is unambiguous while its neighbours stay visible for context.
      const dimmed = selection.kind === 'sector' && !isSector;

      // The pattern tail, behind the rated wedge. Non-interactive: it overlaps
      // its neighbours by design, so letting it take clicks would make picking
      // the sector you meant ambiguous exactly where the sectors meet.
      L.polygon(sectorWedge(radio, radiusM, patternWidthDeg(radio.beamWidthDeg, OUTER_CONTOUR_DB)), {
        stroke: false,
        fillColor: '#0ea5e9',
        fillOpacity: dimmed ? 0.015 : isSector ? 0.05 : 0.03,
        interactive: false,
      }).addTo(group);

      const wedge = L.polygon(sectorWedge(radio, radiusM, radio.beamWidthDeg), {
        color: highlighted ? '#38bdf8' : '#0ea5e9',
        weight: isSector ? 2.5 : 1,
        dashArray: isSector ? undefined : '4 4',
        fillColor: '#0ea5e9',
        fillOpacity: isSector ? 0.2 : dimmed ? 0.03 : 0.07,
        opacity: dimmed ? 0.35 : 0.9,
      });
      wedge.on('click', event => {
        L.DomEvent.stopPropagation(event as unknown as Event);
        handlers.current.onSelect({ kind: 'sector', id: radio.id });
      });
      wedge.bindTooltip(
        `<strong>${radio.name}</strong><br/>${radio.azimuthDeg}° azimuth · ${radio.beamWidthDeg}° beam` +
        `<br/>${radio.txPowerDbm} dBm · ${radio.frequencyGhz} GHz` +
        `<br/>solid edge = ${radio.beamWidthDeg}° half-power beam` +
        `<br/>faint tail = ${Math.round(patternWidthDeg(radio.beamWidthDeg, OUTER_CONTOUR_DB))}° at −${OUTER_CONTOUR_DB} dB, where sectors overlap` +
        `<br/><em>click to edit this sector</em>`,
        { sticky: true },
      );
      wedge.addTo(group);
    }
  }, [radios, selection, layers.sectors, radiusM]);

  // ── one marker per SITE ───────────────────────────────────────────────────
  useEffect(() => {
    const group = markerGroupRef.current;
    if (!group) return;
    group.clearLayers();
    for (const site of groupBySite(radios)) {
      const first = site.sectors[0];
      if (!first) continue;
      const selected =
        (selection.kind === 'site' && selection.id === site.siteId) ||
        (selection.kind === 'sector' && site.sectors.some(s => s.id === selection.id));
      const marker = L.marker([first.latitude, first.longitude], {
        icon: siteIcon(site.sectors.length, selected),
        // Only the selected site is draggable: making every marker draggable
        // means an ordinary click-to-select often becomes an accidental 1 px
        // drag, which silently moves a site.
        draggable: selected,
        keyboard: true,
        title: `${site.siteName} — ${site.sectors.length} sector(s)`,
      });
      marker.on('click', event => {
        L.DomEvent.stopPropagation(event as unknown as Event);
        handlers.current.onSelect({ kind: 'site', id: site.siteId });
      });
      marker.on('dragend', () => {
        const position = marker.getLatLng();
        // Moving a site moves every panel on it — they share one mast.
        handlers.current.onMoveSite(site.siteId, position.lat, position.lng);
      });
      marker.bindTooltip(
        `<strong>${site.siteName}</strong><br/>${site.sectors.length} sector(s) · ` +
        `${first.technology.toUpperCase()} ${first.frequencyGhz} GHz · ${first.antennaHeightM} m` +
        (selected ? '<br/><em>drag to move the whole site</em>' : '<br/><em>click to edit the site</em>'),
        { direction: 'top', offset: [0, -12] },
      );
      marker.addTo(group);
    }
  }, [radios, selection]);

  // ── fit to the radios the first time there are any ────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current || radios.length === 0) return;
    fittedRef.current = true;
    if (groupBySite(radios).length === 1) {
      map.setView([radios[0].latitude, radios[0].longitude], 16);
      return;
    }
    map.fitBounds(L.latLngBounds(radios.map(r => [r.latitude, r.longitude] as L.LatLngTuple)).pad(0.25));
  }, [radios]);

  // ── keep the selected thing on screen ─────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || selection.kind === 'none' || selection.kind === 'building') return;
    const radio = selection.kind === 'sector'
      ? radios.find(r => r.id === selection.id)
      : radios.find(r => r.siteId === selection.id);
    if (!radio) return;
    const position = L.latLng(radio.latitude, radio.longitude);
    // Only pan when it is actually off screen. Recentring on every selection
    // would yank the map around while someone is simply clicking through
    // sectors to compare them.
    if (!map.getBounds().pad(-0.15).contains(position)) {
      map.panTo(position, { animate: true });
    }
    // Deliberately keyed on the selected id alone: panning again on every
    // radios change would fight the user mid-drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.kind, selection.kind === 'none' ? null : selection.id]);

  const focusSelected = useCallback(() => {
    const map = mapRef.current;
    if (!map || selection.kind === 'none') return;
    if (selection.kind === 'building') return;
    const radio = selection.kind === 'sector'
      ? radios.find(r => r.id === selection.id)
      : radios.find(r => r.siteId === selection.id);
    if (radio) map.setView([radio.latitude, radio.longitude], Math.max(map.getZoom(), 16));
  }, [radios, selection]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full rounded-lg overflow-hidden" />
      {mode === 'place' && (
        <div
          className="absolute left-1/2 -translate-x-1/2 top-3 z-[500] px-3 py-1.5 rounded-md bg-nms-surface border border-nms-accent text-xs flex items-center gap-2 shadow-lg"
          role="status"
          aria-live="polite"
        >
          Click the map to place the site
          <kbd className="px-1.5 py-0.5 rounded border border-nms-border-strong text-nms-text-dim">Esc</kbd>
          to cancel
        </div>
      )}
      {selection.kind !== 'none' && selection.kind !== 'building' && (
        <button
          type="button"
          onClick={focusSelected}
          className="absolute right-3 bottom-3 z-[500] nms-btn-ghost text-xs px-2.5 py-1.5 border border-nms-border bg-nms-surface"
        >
          Centre on selected
        </button>
      )}
    </div>
  );
}
