import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { rfPlanningApi } from '../../api/rfPlanning';
import type { PointAnalysisInput, PointAnalysisResult, CalculationResult } from '../../api/rfPlanning';
import { NumField, EquationDisclosure, AssumptionsWarnings, ResultLine, fixLeafletDefaultIcon } from './shared';

fixLeafletDefaultIcon();

// A small colored dot (not the default blue pin, which the Site marker
// keeps) so Site and Target are visually distinguishable at a glance.
const TARGET_ICON = L.divIcon({
  className: '',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#f97316;border:2px solid white;box-shadow:0 0 2px rgba(0,0,0,0.6);"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
});

export function PointAnalysisTab() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const siteMarkerRef = useRef<L.Marker | null>(null);
  const targetMarkerRef = useRef<L.Marker | null>(null);
  const hasFitBoundsRef = useRef(false);

  const [form, setForm] = useState({
    siteLat: '', siteLon: '', siteHeightM: '30',
    targetLat: '', targetLon: '', targetHeightM: '1.5',
    mechanicalDowntiltDeg: '', electricalDowntiltDeg: '',
  });
  const [useTerrainData, setUseTerrainData] = useState(false);
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<CalculationResult<PointAnalysisResult> | null>(null);

  // Which marker a plain map click sets — explicit, not inferred, so
  // there's never ambiguity about which point a click means.
  const [placingMode, setPlacingMode] = useState<'site' | 'target'>('site');
  const placingModeRef = useRef(placingMode);
  useEffect(() => { placingModeRef.current = placingMode; }, [placingMode]);

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  // Map setup — runs once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current).setView(
      [Number(form.siteLat) || 20, Number(form.siteLon) || 0],
      Number(form.siteLat) ? 12 : 2,
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(map);

    const siteMarker = L.marker([Number(form.siteLat) || 0, Number(form.siteLon) || 0], { draggable: true }).addTo(map);
    siteMarker.on('dragend', () => {
      const ll = siteMarker.getLatLng();
      setForm(f => ({ ...f, siteLat: ll.lat.toFixed(6), siteLon: ll.lng.toFixed(6) }));
    });
    siteMarkerRef.current = siteMarker;

    const targetMarker = L.marker([Number(form.targetLat) || 0, Number(form.targetLon) || 0], { draggable: true, icon: TARGET_ICON }).addTo(map);
    targetMarker.on('dragend', () => {
      const ll = targetMarker.getLatLng();
      setForm(f => ({ ...f, targetLat: ll.lat.toFixed(6), targetLon: ll.lng.toFixed(6) }));
    });
    targetMarkerRef.current = targetMarker;

    map.on('click', (e: L.LeafletMouseEvent) => {
      const { lat, lng } = e.latlng;
      if (placingModeRef.current === 'site') {
        setForm(f => ({ ...f, siteLat: lat.toFixed(6), siteLon: lng.toFixed(6) }));
      } else {
        setForm(f => ({ ...f, targetLat: lat.toFixed(6), targetLon: lng.toFixed(6) }));
      }
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep markers synced with manually-typed lat/lon.
  useEffect(() => {
    const lat = Number(form.siteLat), lon = Number(form.siteLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !siteMarkerRef.current) return;
    siteMarkerRef.current.setLatLng([lat, lon]);
  }, [form.siteLat, form.siteLon]);

  useEffect(() => {
    const lat = Number(form.targetLat), lon = Number(form.targetLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !targetMarkerRef.current) return;
    targetMarkerRef.current.setLatLng([lat, lon]);
  }, [form.targetLat, form.targetLon]);

  // Fit both points into view once, the first time both are valid — not on
  // every subsequent change, so it doesn't fight manual pan/zoom afterward.
  useEffect(() => {
    if (hasFitBoundsRef.current || !mapRef.current) return;
    const siteLat = Number(form.siteLat), siteLon = Number(form.siteLon);
    const targetLat = Number(form.targetLat), targetLon = Number(form.targetLon);
    if (![siteLat, siteLon, targetLat, targetLon].every(Number.isFinite)) return;
    mapRef.current.fitBounds([[siteLat, siteLon], [targetLat, targetLon]], { padding: [40, 40] });
    hasFitBoundsRef.current = true;
  }, [form.siteLat, form.siteLon, form.targetLat, form.targetLon]);

  const submit = async () => {
    setLoading(true);
    setRes(null);
    try {
      const input: PointAnalysisInput = {
        siteLat: Number(form.siteLat),
        siteLon: Number(form.siteLon),
        siteHeightM: Number(form.siteHeightM),
        targetLat: Number(form.targetLat),
        targetLon: Number(form.targetLon),
        targetHeightM: Number(form.targetHeightM),
        mechanicalDowntiltDeg: form.mechanicalDowntiltDeg ? Number(form.mechanicalDowntiltDeg) : undefined,
        electricalDowntiltDeg: form.electricalDowntiltDeg ? Number(form.electricalDowntiltDeg) : undefined,
        useTerrainData,
      };
      const result = await rfPlanningApi.pointAnalysis(input);
      setRes(result);
      if (!result.ok) toast.error(result.error?.reason || 'Calculation failed');
    } catch (err: any) {
      toast.error(err?.response?.data?.error?.reason || 'Request failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="nms-card space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm font-semibold text-nms-text">
            Site &amp; Target Map — click or drag the pins to place them
          </p>
          <div className="flex items-center gap-1 p-0.5 bg-nms-surface-2 rounded-md border border-nms-border">
            <span className="px-2 py-0.5 text-[11px] text-nms-text-dim">Placing:</span>
            <button
              type="button" onClick={() => setPlacingMode('site')}
              className={clsx('px-2 py-0.5 rounded text-[11px] font-medium', placingMode === 'site' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text')}
            >
              Site
            </button>
            <button
              type="button" onClick={() => setPlacingMode('target')}
              className={clsx('px-2 py-0.5 rounded text-[11px] font-medium', placingMode === 'target' ? 'bg-nms-accent text-white' : 'text-nms-text-dim hover:text-nms-text')}
            >
              Target
            </button>
          </div>
        </div>
        <div ref={mapContainerRef} style={{ height: 400 }} className="rounded-lg overflow-hidden border border-nms-border" />
        <div className="flex items-center gap-4 flex-wrap text-[11px] text-nms-text-dim">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block bg-[#3388ff]" />
            Site
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: '#f97316' }} />
            Target
          </span>
        </div>
      </div>

      <div className="space-y-6">
        <div className="nms-card space-y-4 w-full">
          <p className="text-sm font-semibold text-nms-text">Site & Target</p>
          <div className="grid grid-cols-3 gap-3">
            <NumField label="Site Lat" value={form.siteLat} onChange={set('siteLat')} unit="deg" />
            <NumField label="Site Lon" value={form.siteLon} onChange={set('siteLon')} unit="deg" />
            <NumField label="Site Height" value={form.siteHeightM} onChange={set('siteHeightM')} unit="m" />
            <NumField label="Target Lat" value={form.targetLat} onChange={set('targetLat')} unit="deg" />
            <NumField label="Target Lon" value={form.targetLon} onChange={set('targetLon')} unit="deg" />
            <NumField label="Target Height" value={form.targetHeightM} onChange={set('targetHeightM')} unit="m" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumField label="Mechanical Downtilt" value={form.mechanicalDowntiltDeg} onChange={set('mechanicalDowntiltDeg')} unit="deg" placeholder="0" />
            <NumField label="Electrical Downtilt" value={form.electricalDowntiltDeg} onChange={set('electricalDowntiltDeg')} unit="deg" placeholder="0" />
          </div>
          <label className="flex items-center gap-2 text-xs text-nms-text">
            <input type="checkbox" checked={useTerrainData} onChange={e => setUseTerrainData(e.target.checked)} className="nms-checkbox" />
            Use real terrain (ground elevation + line-of-sight)
          </label>
          <button onClick={submit} disabled={loading} className="nms-btn-primary w-full">
            {loading ? 'Calculating…' : 'Calculate Point Analysis'}
          </button>
        </div>

        <div className="space-y-4 w-full">
          {res?.ok && res.result && (
            <div className="nms-card space-y-2">
              <p className="text-sm font-semibold text-nms-text mb-1">Result</p>
              <ResultLine label="Distance" value={res.result.distanceM} unit="m" />
              <ResultLine label="Bearing" value={res.result.bearingDeg} unit="deg" />
              <ResultLine label="Elevation Angle" value={res.result.elevationAngleDeg} unit="deg" />
              <ResultLine label="Geometric Downtilt Required" value={res.result.geometricDowntiltDeg} unit="deg" />
              {res.result.totalConfiguredDowntiltDeg !== undefined && (
                <ResultLine label="Total Configured Downtilt" value={res.result.totalConfiguredDowntiltDeg} unit="deg" />
              )}
              {res.result.siteGroundElevationM !== undefined && (
                <ResultLine label="Site Ground Elevation" value={res.result.siteGroundElevationM} unit="m" />
              )}
              {res.result.targetGroundElevationM !== undefined && (
                <ResultLine label="Target Ground Elevation" value={res.result.targetGroundElevationM} unit="m" />
              )}
              {res.result.diffractionLossDb !== undefined && (
                <ResultLine label="Diffraction Loss (preview)" value={res.result.diffractionLossDb} unit="dB" />
              )}
              {res.result.isLineOfSight !== undefined && (
                <div className="flex items-center justify-between px-3 py-2 bg-nms-bg border border-nms-border rounded-lg">
                  <span className="text-sm text-nms-text-dim">Line of Sight</span>
                  <span className={clsx('text-sm font-semibold', res.result.isLineOfSight ? 'text-green-400' : 'text-red-400')}>
                    {res.result.isLineOfSight ? 'Clear' : 'Blocked'}
                  </span>
                </div>
              )}
              {res.result.losClassification && (
                <div className="flex items-center justify-between px-3 py-2 bg-nms-bg border border-nms-border rounded-lg">
                  <span className="text-sm text-nms-text-dim">
                    Fresnel Clearance{res.result.fresnelClearancePercent != null ? ` (${res.result.fresnelClearancePercent.toFixed(0)}%)` : ''}
                  </span>
                  <span className={clsx('text-sm font-semibold',
                    res.result.losClassification === 'los' ? 'text-green-400' : res.result.losClassification === 'partial' ? 'text-amber-400' : 'text-red-400')}>
                    {res.result.losClassification === 'los' ? 'Clear' : res.result.losClassification === 'partial' ? 'Partial' : 'Blocked'}
                  </span>
                </div>
              )}
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
              <p className="text-xs font-semibold text-nms-text-dim uppercase tracking-wider">Calculation Chain</p>
              {res.calculation.map((eq, i) => <EquationDisclosure key={i} eq={eq} />)}
            </div>
          )}
          {res && <AssumptionsWarnings res={res} />}
        </div>
      </div>
    </div>
  );
}
