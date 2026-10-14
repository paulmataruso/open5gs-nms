import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Crosshair, Play, Building2, Compass, Loader2, AlertTriangle, X, Radio as RadioIcon,
  Layers, ListChecks, Info, Flame, FileDown, ChevronDown,
} from 'lucide-react';
import { PlanningMap, type MapMode, type Selection } from '../components/rfplanning/PlanningMap';
import { RadioEditor } from '../components/rfplanning/RadioEditor';
import { SiteEditor } from '../components/rfplanning/SiteEditor';
import { BuildingInspector } from '../components/rfplanning/BuildingInspector';
import { ModelPicker } from '../components/rfplanning/ModelPicker';
import { ProjectBar } from '../components/rfplanning/ProjectBar';
import {
  buildHeatmapDataUrl, legendFor, gradientCssFor, type HeatmapMetric,
} from '../components/rfplanning/heatmapRaster';
import {
  rfSimulationApi, createSite, groupBySite, SITE_LAYOUTS,
  reportCells, reportQuality, reportGaps,
  type PlanningRadio, type PlanningBuilding, type SimulateResult, type HeatmapResult,
  type SiteLayout, type PropagationModelId, type ModelOptions, type AntennaModel,
} from '../api/rfSimulation';

// RF Planning.
//
// The workflow is the design: place a site, set its parameters, simulate.
// Everything else — buildings, heatmap, optimisation, gap analysis, the report
// — hangs off that one line and is optional.
//
// The right-hand panel is a CONTEXT inspector: whatever you select on the map
// (a site, one of its sectors, a building) becomes what the panel edits. It is
// docked beside the map rather than floating over it, so the geometry you are
// changing stays visible while you change it — a popup would cover the exact
// thing you need to watch.
//
// State lives here rather than in a store because it is one screen's worth and
// every piece of it is needed by both the map and the panel. Pushing it into a
// global store would buy nothing and cost traceability.

type SidePanel = 'inspector' | 'results';

export function RfPlanningPage() {
  const [radios, setRadios] = useState<PlanningRadio[]>([]);
  const [buildings, setBuildings] = useState<PlanningBuilding[]>([]);
  const [buildingAttribution, setBuildingAttribution] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [mode, setMode] = useState<MapMode>('inspect');
  const [placeLayout, setPlaceLayout] = useState<SiteLayout>('3-sector');
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [layers, setLayers] = useState({ heatmap: true, rays: true, sectors: true, buildings: true });
  const [radiusM, setRadiusM] = useState(400);
  const [rays, setRays] = useState(60);
  const [model, setModel] = useState<PropagationModelId>('uma');
  const [modelOptions, setModelOptions] = useState<ModelOptions>({});
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResult | null>(null);
  const [metric, setMetric] = useState<HeatmapMetric>('rsrp');
  // Smooth by default: path loss is continuous, so a banded raster draws
  // contour edges the propagation does not have. Bands stay available
  // because they are easier to read one pass/fail boundary off.
  const [smoothHeatmap, setSmoothHeatmap] = useState(true);
  const [busy, setBusy] = useState<null | 'simulate' | 'buildings' | 'optimize' | 'heatmap' | 'report'>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const [panel, setPanel] = useState<SidePanel>('inspector');
  // The antenna catalogue is served, not bundled, so the numbers the UI
  // shows are the same ones the engine simulates with and the backend tests
  // assert on. Until it arrives, placement falls back to the layout's own
  // beamwidth and the built-in defaults.
  const [antennas, setAntennas] = useState<AntennaModel[]>([]);
  const [defaultFrontToBackDb, setDefaultFrontToBackDb] = useState(20);
  const viewportRef = useRef({ minLon: -72.19, minLat: 43.37, maxLon: -72.17, maxLat: 43.38 });

  const sites = useMemo(() => groupBySite(radios), [radios]);

  // The raster is derived, so switching metric recolours instantly without
  // asking the backend for the same numbers again.
  const overlay = useMemo(() => {
    if (!heatmap) return null;
    const dataUrl = buildHeatmapDataUrl({
      values: metric === 'sinr' ? heatmap.sinrDb : heatmap.rsrpDbm,
      cols: heatmap.cols, rows: heatmap.rows, metric, smooth: smoothHeatmap,
    });
    return dataUrl ? { dataUrl, bounds: heatmap.bounds } : null;
  }, [heatmap, metric, smoothHeatmap]);

  const select = useCallback((next: Selection) => {
    setSelection(next);
    if (next.kind !== 'none') setPanel('inspector');
  }, []);

  useEffect(() => {
    let cancelled = false;
    rfSimulationApi.antennas().then(response => {
      if (cancelled || !response.ok || !response.result) return;
      setAntennas(response.result.antennas);
      setDefaultFrontToBackDb(response.result.defaultFrontToBackDb);
    }).catch(() => { /* placement still works on the built-in defaults */ });
    return () => { cancelled = true; };
  }, []);

  // ── mutations ─────────────────────────────────────────────────────────────
  const placeSite = useCallback((latitude: number, longitude: number) => {
    setRadios(current => {
      const siteNumber = groupBySite(current).length + 1;
      const antenna = antennas.find(a => a.id === SITE_LAYOUTS[placeLayout].defaultAntennaId);
      const sectors = createSite(placeLayout, siteNumber, latitude, longitude, antenna);
      // A multi-sector site opens on the SITE, where the shared parameters
      // are; a single-sector one opens on its only sector, since there is no
      // meaningful site-level choice to make first.
      setSelection(sectors.length > 1 ? { kind: 'site', id: sectors[0].siteId } : { kind: 'sector', id: sectors[0].id });
      return [...current, ...sectors];
    });
    // One click, one site: staying in place mode is how you end up with five
    // sites stacked on a double-click.
    setMode('inspect');
    setPanel('inspector');
  }, [placeLayout, antennas]);

  const patchSector = useCallback((id: string, patch: Partial<PlanningRadio>) => {
    setRadios(current => current.map(r => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  const patchSite = useCallback((siteId: string, patch: Partial<PlanningRadio>) => {
    setRadios(current => current.map(r => (r.siteId === siteId ? { ...r, ...patch } : r)));
  }, []);

  const renameSite = useCallback((siteId: string, siteName: string) => {
    setRadios(current => current.map(r => {
      if (r.siteId !== siteId) return r;
      // Only follow the rename for sector names that were never customised —
      // a hand-written sector name is the operator's, not ours to rewrite.
      const wasDefault = r.name === r.siteName || r.name === `${r.siteName} ${r.sectorLabel}`;
      const name = wasDefault
        ? (r.sectorLabel === 'Omni' ? siteName : `${siteName} ${r.sectorLabel}`)
        : r.name;
      return { ...r, siteName, name };
    }));
  }, []);

  const moveSite = useCallback((siteId: string, latitude: number, longitude: number) => {
    setRadios(current => current.map(r => (r.siteId === siteId ? { ...r, latitude, longitude } : r)));
  }, []);

  const deleteSite = useCallback((siteId: string) => {
    setRadios(current => current.filter(r => r.siteId !== siteId));
    setSelection({ kind: 'none' });
  }, []);

  const deleteSector = useCallback((id: string) => {
    setRadios(current => {
      const target = current.find(r => r.id === id);
      const remaining = current.filter(r => r.id !== id);
      // Deleting the last sector of a site deletes the site with it, rather
      // than leaving an invisible mast with nothing on it.
      const siblings = target ? remaining.filter(r => r.siteId === target.siteId) : [];
      setSelection(siblings.length > 0 && target ? { kind: 'site', id: target.siteId } : { kind: 'none' });
      return remaining;
    });
  }, []);

  const addSector = useCallback((sector: PlanningRadio) => {
    setRadios(current => [...current, sector]);
    setSelection({ kind: 'sector', id: sector.id });
  }, []);

  // ── actions ───────────────────────────────────────────────────────────────
  const importBuildings = useCallback(async () => {
    setBusy('buildings');
    setMessage(null);
    const response = await rfSimulationApi.importBuildings(viewportRef.current);
    setBusy(null);
    if (!response.ok || !response.result) {
      setMessage({ kind: 'error', text: response.error?.reason ?? 'could not import buildings' });
      return;
    }
    setBuildings(response.result.buildings);
    setBuildingAttribution(response.result.attribution);
    setMessage({
      kind: 'info',
      text: response.result.count === 0
        ? 'No mapped building footprints in this view. Pan to a built-up area, or carry on without them — buildings are optional.'
        : `Imported ${response.result.count} building footprints` +
          (response.result.cached ? ' (from cache).' : ` from ${response.result.endpoint.replace(/^https?:\/\//, '').split('/')[0]}.`),
    });
  }, []);

  const simulate = useCallback(async () => {
    if (radios.length === 0) {
      setMessage({ kind: 'error', text: 'Place at least one site first.' });
      return;
    }
    setBusy('simulate');
    setMessage(null);
    const response = await rfSimulationApi.simulate({
      cells: radios, radiusM, rays,
      buildings: buildings.length ? buildings : undefined,
      propagationModel: model, modelOptions,
    });
    setBusy(null);
    if (!response.ok || !response.result) {
      setMessage({ kind: 'error', text: response.error?.reason ?? 'simulation failed' });
      return;
    }
    setResult(response.result);
    setPanel('results');
    const warnings = [
      ...response.result.warnings,
      ...response.result.cells.flatMap(c => c.applicability.warnings),
    ];
    if (warnings.length) setMessage({ kind: 'info', text: warnings[0] });
  }, [radios, radiusM, rays, buildings, model, modelOptions]);

  const runHeatmap = useCallback(async () => {
    if (radios.length === 0) {
      setMessage({ kind: 'error', text: 'Place at least one site first.' });
      return;
    }
    setBusy('heatmap');
    setMessage(null);
    const response = await rfSimulationApi.coverageHeatmap({
      cells: radios, radiusM,
      buildings: buildings.length ? buildings : undefined,
      propagationModel: model, modelOptions,
    });
    setBusy(null);
    if (!response.ok || !response.result) {
      setMessage({ kind: 'error', text: response.error?.reason ?? 'heatmap failed' });
      return;
    }
    setHeatmap(response.result);
    setLayers(l => ({ ...l, heatmap: true }));
    setMessage({
      kind: 'info',
      text: `Coverage raster: ${response.result.stats.coveredPct}% of the area has usable signal, ` +
            `${response.result.cellSizeM} m grid (${response.result.cols}×${response.result.rows}).`,
    });
  }, [radios, radiusM, buildings, model, modelOptions]);

  const optimize = useCallback(async () => {
    if (radios.length === 0) { setMessage({ kind: 'error', text: 'Place at least one site first.' }); return; }
    if (buildings.length === 0) {
      setMessage({ kind: 'error', text: 'Optimisation ranks against building demand — import buildings first.' });
      return;
    }
    setBusy('optimize');
    setMessage(null);
    const response = await rfSimulationApi.optimize({ cells: radios, buildings, radiusM, rays: 16, azimuthStepDeg: 15 });
    setBusy(null);
    if (!response.ok || !response.result) {
      setMessage({ kind: 'error', text: response.error?.reason ?? 'optimisation failed' });
      return;
    }
    const { best } = response.result;
    setRadios(current => current.map(r => {
      const azimuth = best.azimuths[r.id];
      return azimuth !== undefined && !r.locked ? { ...r, azimuthDeg: azimuth } : r;
    }));
    setMessage({
      kind: 'info',
      text: `Azimuths updated: ${best.demandServedPct}% of demand served, score ${best.score}. ` +
            `${response.result.pareto.length} alternative trade-offs found. Simulate again to see the rays.`,
    });
  }, [radios, buildings, radiusM]);

  const exportReport = useCallback(async () => {
    if (radios.length === 0) { setMessage({ kind: 'error', text: 'Place at least one site first.' }); return; }
    setBusy('report');
    setMessage(null);
    // Re-render the raster opaque for print: the 55% alpha that keeps the
    // basemap readable on screen washes out on white paper.
    const png = heatmap
      ? buildHeatmapDataUrl({
          values: metric === 'sinr' ? heatmap.sinrDb : heatmap.rsrpDbm,
          cols: heatmap.cols, rows: heatmap.rows, metric, opaque: true,
          smooth: smoothHeatmap,
        })
      : null;
    const outcome = await rfSimulationApi.report({
      title: sites.length === 1 ? `${sites[0].siteName} coverage plan` : 'RF Coverage Plan',
      radios,
      // Projected, not passed whole: a CellResult carries every ray's
      // geometry and the PDF only prints the stats table, so sending the full
      // result uploaded megabytes to be discarded and tripped nginx's body cap
      // as a bare HTTP 413 on any plan with a large radius or ray count.
      cells: reportCells(result?.cells ?? []),
      quality: reportQuality(result?.quality ?? []),
      gaps: reportGaps(result?.gaps ?? null),
      resourceGrid: result?.resourceGrid ?? null,
      settings: { radiusM, rays, buildingsConsidered: buildings.length },
      propagationModel: model,
      warnings: [
        ...(result?.warnings ?? []),
        ...(result?.cells.flatMap(c => c.applicability.warnings) ?? []),
      ],
      attribution: buildingAttribution,
      notes: null,
      heatmapPngBase64: png ?? undefined,
      heatmapMeta: heatmap && png
        ? {
            metric: metric === 'sinr' ? 'SINR' : 'signal strength (RSRP)',
            legend: legendFor(metric).map(stop => ({ label: stop.label, color: stop.color })),
            coveredPct: heatmap.stats.coveredPct,
            cellSizeM: heatmap.cellSizeM,
          }
        : undefined,
    });
    setBusy(null);
    setMessage(outcome.ok
      ? { kind: 'info', text: 'Report downloaded.' }
      : { kind: 'error', text: outcome.reason });
  }, [radios, result, heatmap, metric, smoothHeatmap, radiusM, rays, buildings, model, buildingAttribution, sites]);

  const steps = [
    { done: radios.length > 0, label: `Place sites${sites.length ? ` (${sites.length})` : ''}` },
    { done: buildings.length > 0, label: `Add buildings${buildings.length ? ` (${buildings.length})` : ''}`, optional: true },
    { done: result !== null, label: 'Simulate' },
  ];

  const selectedSector = selection.kind === 'sector' ? radios.find(r => r.id === selection.id) ?? null : null;
  const selectedSite = selection.kind === 'site'
    ? sites.find(s => s.siteId === selection.id) ?? null
    : selectedSector
      ? sites.find(s => s.siteId === selectedSector.siteId) ?? null
      : null;
  const selectedBuilding = selection.kind === 'building' ? buildings.find(b => b.id === selection.id) ?? null : null;

  return (
    <div className="p-6 h-full flex flex-col gap-4 min-h-0">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display">RF Planning</h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Drop a site on the map, set its sectors, and simulate coverage with ray tracing and a heatmap.
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <ProjectBar
            radios={radios}
            onLoad={(loaded, projectName) => {
              setRadios(loaded);
              setSelection(loaded[0] ? { kind: 'sector', id: loaded[0].id } : { kind: 'none' });
              setResult(null);
              setHeatmap(null);
              setPanel('inspector');
              document.title = `RF Planning — ${projectName}`;
            }}
            onMessage={(kind, text) => setMessage({ kind, text })}
          />
          <ol className="flex items-center gap-2 text-xs" aria-label="Workflow progress">
            {steps.map((step, index) => (
              <li key={step.label} className="flex items-center gap-2">
                {index > 0 && <span className="text-nms-text-dim" aria-hidden="true">→</span>}
                <span
                  className={`px-2 py-1 rounded border ${
                    step.done ? 'border-nms-green text-nms-green' : 'border-nms-border text-nms-text-dim'
                  }`}
                >
                  {index + 1}. {step.label}{step.optional && !step.done ? ' · optional' : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {/* One toolbar, in workflow order. */}
      <div className="flex items-start gap-2 flex-wrap">
        {/* Place, with the antenna arrangement attached to the button. */}
        <div className="flex">
          <button
            type="button"
            onClick={() => setMode(m => (m === 'place' ? 'inspect' : 'place'))}
            aria-pressed={mode === 'place'}
            className={`flex items-center gap-2 px-3 py-2 rounded-l-md text-sm font-medium border transition-all ${
              mode === 'place'
                ? 'bg-nms-accent text-nms-accent-fg border-nms-accent'
                : 'border-nms-border-strong hover:bg-nms-surface'
            }`}
          >
            {mode === 'place' ? <X className="w-4 h-4" aria-hidden="true" /> : <Crosshair className="w-4 h-4" aria-hidden="true" />}
            {mode === 'place' ? 'Cancel placement' : `Add ${SITE_LAYOUTS[placeLayout].label.toLowerCase()}`}
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setLayoutMenuOpen(o => !o)}
              aria-expanded={layoutMenuOpen}
              aria-label="Choose antenna arrangement"
              className="h-full px-2 rounded-r-md border border-l-0 border-nms-border-strong hover:bg-nms-surface"
            >
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </button>
            {layoutMenuOpen && (
              <div
                className="absolute left-0 top-full mt-1 z-50 w-72 rounded-md border border-nms-border bg-nms-surface shadow-lg p-1"
                role="menu"
              >
                {(Object.keys(SITE_LAYOUTS) as SiteLayout[]).map(key => (
                  <button
                    key={key}
                    type="button"
                    role="menuitemradio"
                    aria-checked={placeLayout === key}
                    onClick={() => { setPlaceLayout(key); setLayoutMenuOpen(false); setMode('place'); }}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs ${
                      placeLayout === key ? 'bg-nms-accent text-nms-accent-fg' : 'hover:bg-nms-surface-2'
                    }`}
                  >
                    <span className="font-medium">{SITE_LAYOUTS[key].label}</span>
                    <span className="block opacity-80">{SITE_LAYOUTS[key].description}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          type="button" onClick={importBuildings} disabled={busy !== null}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
        >
          {busy === 'buildings'
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : <Building2 className="w-4 h-4" aria-hidden="true" />}
          Import buildings
        </button>

        <button
          type="button" onClick={simulate} disabled={busy !== null || radios.length === 0}
          className="nms-btn-primary flex items-center gap-2 px-4 py-2 text-sm disabled:opacity-50"
        >
          {busy === 'simulate'
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : <Play className="w-4 h-4" aria-hidden="true" />}
          Simulate
        </button>

        <button
          type="button" onClick={runHeatmap} disabled={busy !== null || radios.length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
        >
          {busy === 'heatmap'
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : <Flame className="w-4 h-4" aria-hidden="true" />}
          Heatmap
        </button>

        <button
          type="button" onClick={optimize} disabled={busy !== null || radios.length === 0 || buildings.length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
          title={buildings.length === 0 ? 'Import buildings first — optimisation ranks against demand' : undefined}
        >
          {busy === 'optimize'
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : <Compass className="w-4 h-4" aria-hidden="true" />}
          Optimise azimuths
        </button>

        <button
          type="button" onClick={exportReport} disabled={busy !== null || radios.length === 0}
          className="flex items-center gap-2 px-3 py-2 rounded-md text-sm border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
        >
          {busy === 'report'
            ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            : <FileDown className="w-4 h-4" aria-hidden="true" />}
          PDF report
        </button>
      </div>

      {/* Model and run settings. */}
      <div className="flex items-start gap-4 flex-wrap border-t border-nms-border pt-3">
        <ModelPicker
          model={model} modelOptions={modelOptions} radios={radios} radiusM={radiusM}
          onChange={setModel} onOptionsChange={setModelOptions}
        />
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-radius" className="text-xs text-nms-text-dim">Radius (m)</label>
            <input id="rf-radius" type="number" step="50" min="50" max="5000" className="nms-input w-20"
              value={radiusM} onChange={e => setRadiusM(Number(e.target.value) || 400)} />
          </div>
          <div className="flex items-center gap-1.5">
            <label htmlFor="rf-rays" className="text-xs text-nms-text-dim">Rays</label>
            <input id="rf-rays" type="number" step="12" min="1" max="360" className="nms-input w-20"
              value={rays} onChange={e => setRays(Number(e.target.value) || 60)} />
          </div>
          {heatmap && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="rf-metric" className="text-xs text-nms-text-dim">Heatmap</label>
              <select
                id="rf-metric" className="nms-input w-28" value={metric}
                onChange={e => setMetric(e.target.value as HeatmapMetric)}
              >
                <option value="rsrp">Signal</option>
                <option value="sinr">SINR</option>
              </select>
              <label className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox" className="nms-checkbox" checked={smoothHeatmap}
                  onChange={e => setSmoothHeatmap(e.target.checked)}
                />
                smooth
              </label>
            </div>
          )}
          <div className="flex items-center gap-2 border-l border-nms-border pl-3" role="group" aria-label="Map layers">
            <Layers className="w-4 h-4 text-nms-text-dim" aria-hidden="true" />
            {(['heatmap', 'rays', 'sectors', 'buildings'] as const).map(key => (
              <label key={key} className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox" className="nms-checkbox" checked={layers[key]}
                  onChange={e => setLayers(l => ({ ...l, [key]: e.target.checked }))}
                />
                {key}
              </label>
            ))}
          </div>
        </div>
      </div>

      {message && (
        <div
          className={`flex items-start gap-2 px-3 py-2 rounded-md border text-sm ${
            message.kind === 'error' ? 'border-nms-red' : 'border-nms-border'
          }`}
          role="status" aria-live="polite"
        >
          {message.kind === 'error'
            ? <AlertTriangle className="w-4 h-4 text-nms-red shrink-0 mt-0.5" aria-hidden="true" />
            : <Info className="w-4 h-4 text-nms-text-dim shrink-0 mt-0.5" aria-hidden="true" />}
          <span className="flex-1">{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="nms-btn-ghost p-0.5" aria-label="Dismiss message">
            <X className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="flex-1 min-h-0 flex gap-4">
        <div className="flex-1 min-w-0 relative">
          <PlanningMap
            radios={radios}
            buildings={buildings}
            results={result?.cells ?? null}
            quality={result?.quality ?? null}
            heatmap={overlay}
            selection={selection}
            mode={mode}
            radiusM={radiusM}
            layers={layers}
            onPlace={placeSite}
            onSelect={select}
            onMoveSite={moveSite}
            onCancelMode={() => setMode('inspect')}
            onViewportChange={bounds => { viewportRef.current = bounds; }}
          />
          {heatmap && layers.heatmap && (
            <div className="absolute left-3 bottom-3 z-[500] rounded-md border border-nms-border bg-nms-surface/95 px-2.5 py-2 text-xs space-y-1">
              <p className="font-medium">{metric === 'sinr' ? 'SINR' : 'Signal (RSRP)'}</p>
              {smoothHeatmap ? (
                // A continuous bar for a continuous raster. Showing five
                // swatches here would imply steps the image no longer has.
                <div className="flex gap-1.5">
                  <span
                    className="w-3 rounded-sm shrink-0"
                    style={{ background: gradientCssFor(metric) }}
                    aria-hidden="true"
                  />
                  <div className="flex flex-col justify-between">
                    {legendFor(metric).map(stop => (
                      <span key={stop.label} className="text-nms-text-dim leading-tight">{stop.label}</span>
                    ))}
                  </div>
                </div>
              ) : (
                legendFor(metric).map(stop => (
                  <div key={stop.label} className="flex items-center gap-1.5">
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: stop.color }} aria-hidden="true" />
                    <span className="text-nms-text-dim">{stop.label}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <aside className="w-80 shrink-0 flex flex-col gap-3 min-h-0">
          <div className="flex justify-center">
            <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
              {([['inspector', 'Inspector', RadioIcon], ['results', 'Results', ListChecks]] as const).map(([key, label, Icon]) => (
                <button
                  key={key} type="button" onClick={() => setPanel(key)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${
                    panel === key ? 'bg-nms-accent text-nms-accent-fg shadow-sm' : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface'
                  }`}
                >
                  <Icon className="w-4 h-4" aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto border border-nms-border rounded-lg p-3">
            {panel === 'results' ? (
              <ResultsPanel result={result} heatmap={heatmap} attribution={buildingAttribution} />
            ) : selectedBuilding ? (
              <BuildingInspector
                building={selectedBuilding}
                quality={result?.quality.find(q => q.buildingId === selectedBuilding.id) ?? null}
                frequencyGhz={radios[0]?.frequencyGhz ?? 3.6}
              />
            ) : selectedSector && selectedSite ? (
              <RadioEditor
                radio={selectedSector}
                siteName={selectedSite.siteName}
                sectorCount={selectedSite.sectors.length}
                antennas={antennas}
                defaultFrontToBackDb={defaultFrontToBackDb}
                onChange={patch => patchSector(selectedSector.id, patch)}
                onDelete={() => deleteSector(selectedSector.id)}
                onDuplicate={() => {
                  const copy: PlanningRadio = {
                    ...selectedSector,
                    id: `${selectedSector.siteId}-${Date.now()}`,
                    name: `${selectedSector.name} copy`,
                    azimuthDeg: (selectedSector.azimuthDeg + 30) % 360,
                  };
                  addSector(copy);
                }}
                onSelectSite={() => select({ kind: 'site', id: selectedSector.siteId })}
              />
            ) : selectedSite ? (
              <SiteEditor
                siteId={selectedSite.siteId}
                sectors={selectedSite.sectors}
                selectedSectorId={null}
                onPatchSite={patch => patchSite(selectedSite.siteId, patch)}
                onRenameSite={name => renameSite(selectedSite.siteId, name)}
                onSelectSector={id => select({ kind: 'sector', id })}
                onAddSector={addSector}
                onDeleteSite={() => deleteSite(selectedSite.siteId)}
              />
            ) : (
              <SiteList sites={sites} onSelect={select} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SiteList({
  sites, onSelect,
}: {
  sites: { siteId: string; siteName: string; sectors: PlanningRadio[] }[];
  onSelect: (selection: Selection) => void;
}) {
  if (sites.length === 0) {
    return (
      <div className="text-center py-10 space-y-2">
        <Crosshair className="w-8 h-8 mx-auto text-nms-text-dim" aria-hidden="true" />
        <p className="text-sm font-medium">No sites yet</p>
        <p className="text-xs text-nms-text-dim">
          Pick an arrangement from the chevron beside <strong>Add</strong>, then click the map.
          Defaults are a CBRS B48/n48 small cell.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-nms-text-dim">
        Select a site, a sector wedge or a building on the map to edit it here.
      </p>
      {sites.map(site => (
        <div key={site.siteId} className="rounded-md border border-nms-border p-2 space-y-1">
          <button
            type="button" onClick={() => onSelect({ kind: 'site', id: site.siteId })}
            className="w-full text-left"
          >
            <p className="text-sm font-medium truncate">{site.siteName}</p>
            <p className="text-xs text-nms-text-dim">
              {site.sectors.length} sector{site.sectors.length === 1 ? '' : 's'} ·{' '}
              {site.sectors[0].technology.toUpperCase()} {site.sectors[0].frequencyGhz} GHz ·{' '}
              {site.sectors[0].antennaHeightM} m
            </p>
          </button>
          <div className="flex gap-1 flex-wrap">
            {site.sectors.map(sector => (
              <button
                key={sector.id} type="button"
                onClick={() => onSelect({ kind: 'sector', id: sector.id })}
                className="px-1.5 py-0.5 rounded border border-nms-border text-xs hover:bg-nms-surface"
              >
                {sector.sectorLabel} {sector.azimuthDeg}°
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ResultsPanel({
  result, heatmap, attribution,
}: {
  result: SimulateResult | null;
  heatmap: HeatmapResult | null;
  attribution: string | null;
}) {
  if (!result && !heatmap) {
    return (
      <div className="text-center py-10 space-y-2">
        <Play className="w-8 h-8 mx-auto text-nms-text-dim" aria-hidden="true" />
        <p className="text-sm font-medium">No simulation yet</p>
        <p className="text-xs text-nms-text-dim">Press Simulate to trace rays, or Heatmap for a coverage raster.</p>
      </div>
    );
  }
  const interferenceLimited = result?.quality.filter(q => q.interferenceLimited).length ?? 0;
  return (
    <div className="space-y-4">
      {heatmap && (
        <section className="space-y-1">
          <h3 className="text-xs font-medium">Coverage raster</h3>
          <p className="text-xs text-nms-text-dim">
            {heatmap.stats.coveredPct}% of {heatmap.stats.samples} sampled points have usable signal ·{' '}
            {heatmap.cellSizeM} m grid · {heatmap.modelLabel}
          </p>
          {heatmap.stats.maxRsrpDbm !== null && (
            <p className="text-xs text-nms-text-dim">
              Range {heatmap.stats.minRsrpDbm} to {heatmap.stats.maxRsrpDbm} dBm
            </p>
          )}
          {heatmap.stats.declined > 0 && (
            <p className="text-xs text-nms-amber">
              {heatmap.stats.declined} point(s) left empty — the model declined them as outside its validity.
            </p>
          )}
        </section>
      )}

      {result && (
        <>
          <section>
            <h3 className="text-xs font-medium mb-2">Per sector · {result.settings.modelLabel}</h3>
            <div className="nms-table-scroll">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-nms-text-dim text-left">
                    <th className="py-1">Sector</th><th>Reach</th><th>Blocked</th><th>Walls</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cells.map(cell => (
                    <tr key={cell.cellId} className="border-t border-nms-border">
                      <td className="py-1 truncate max-w-[7rem]">{cell.name ?? cell.cellId}</td>
                      <td>{cell.stats.avgReachM} m</td>
                      <td>{cell.stats.blockedRayPct}%</td>
                      <td>{cell.stats.wallEventTotal}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="space-y-1">
            <h3 className="text-xs font-medium">Radio quality</h3>
            <p className="text-xs text-nms-text-dim">
              {result.resourceGrid.resourceBlocks} RB at {result.resourceGrid.subcarrierSpacingKhz} kHz SCS
              ({result.resourceGrid.measurementFamily === 'nr_ss' ? 'NR SS' : 'LTE CRS'})
            </p>
            {result.quality.length === 0 ? (
              <p className="text-xs text-nms-text-dim">No buildings illuminated — import buildings to score quality.</p>
            ) : (
              <>
                <div className="flex gap-2 flex-wrap text-xs">
                  {(['good', 'fair', 'poor', 'unusable'] as const).map(cls => {
                    const count = result.quality.filter(q => q.qualityClass === cls).length;
                    return (
                      <span key={cls} className="px-2 py-0.5 rounded border border-nms-border">
                        {cls} {count}
                      </span>
                    );
                  })}
                </div>
                {interferenceLimited > 0 && (
                  <p className="text-xs text-nms-amber">
                    {interferenceLimited} building(s) are interference-limited: signal is adequate but SINR or RSRQ is not.
                    Re-point or de-load a neighbouring sector rather than adding power.
                  </p>
                )}
              </>
            )}
          </section>

          {result.gaps && result.gaps.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-xs font-medium">Coverage gaps</h3>
              {result.gaps.map(gap => (
                <div key={gap.cellId} className="text-xs">
                  <p className="text-nms-text-dim">
                    {gap.cellId}: {gap.summary.gapBuildings} of {gap.summary.candidateBuildings} in-beam buildings unserved
                    {gap.summary.totalDemandWeight > 0 && ` · ${gap.summary.demandServedPct}% of demand served`}
                  </p>
                  {gap.gaps.slice(0, 3).map(entry => (
                    <p key={entry.buildingId} className="pl-2 text-nms-text-dim opacity-80 truncate">
                      {entry.buildingId} · demand {entry.combinedDemand} ·{' '}
                      {entry.bestRxDbm === null ? 'never illuminated' : `${entry.bestRxDbm.toFixed(0)} dBm`}
                    </p>
                  ))}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      <p className="text-xs text-nms-text-dim border-t border-nms-border pt-2">
        Planning estimates from static geometry — not drive-test, UE or PHY measurements.
        {attribution && <> Buildings: {attribution}.</>}
      </p>
    </div>
  );
}
