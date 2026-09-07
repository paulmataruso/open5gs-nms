import { useState } from 'react';
import { Radar, Calculator, MapPin, Map as MapIcon } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { rfPlanningApi } from '../api/rfPlanning';
import type {
  LinkBudgetInput, LinkBudgetResult,
  CalculationResult, PropagationModel, HataEnvironment, Cost231CityType, LogDistanceEnvironment, WalfischIkegamiMode,
} from '../api/rfPlanning';
import { NumField, SelectField, EquationDisclosure, AssumptionsWarnings, ResultLine } from '../components/rfplanning/shared';
import { CoverageMapTab } from '../components/rfplanning/CoverageMapTab';
import { PointAnalysisTab } from '../components/rfplanning/PointAnalysisTab';

type Tab = 'link-budget' | 'point-analysis' | 'coverage-map';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'link-budget',    label: 'Link Budget',    icon: <Calculator className="w-4 h-4" /> },
  { id: 'point-analysis', label: 'Point Analysis', icon: <MapPin className="w-4 h-4" /> },
  { id: 'coverage-map',   label: 'Coverage Map',   icon: <MapIcon className="w-4 h-4" /> },
];

function LinkBudgetTab() {
  const [form, setForm] = useState({
    txPowerDbm: '40',
    cableLossDb: '2',
    connectorLossDb: '0.5',
    filterLossDb: '',
    antennaGainDbi: '17',
    frequencyMhz: '3570',
    distanceM: '1000',
    buildingLossDb: '12',
    foliageLossDb: '',
    miscLossDb: '',
    ueAntennaGainDbi: '',
    txHeightM: '',
    rxHeightM: '',
  });
  const [model, setModel] = useState<{
    propagationModel: PropagationModel; environment: HataEnvironment; cityType: Cost231CityType;
    isLineOfSight: boolean; pathLossExponent: string; logDistanceEnvironment: LogDistanceEnvironment;
    walfischIkegamiMode: WalfischIkegamiMode; buildingHeightM: string; streetWidthM: string;
    buildingSeparationM: string; streetOrientationDeg: string;
  }>({
    propagationModel: 'fspl', environment: 'urban', cityType: 'medium', isLineOfSight: false, pathLossExponent: '',
    logDistanceEnvironment: 'urban',
    walfischIkegamiMode: 'nlos', buildingHeightM: '', streetWidthM: '', buildingSeparationM: '', streetOrientationDeg: '',
  });
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<CalculationResult<LinkBudgetResult> | null>(null);

  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  const submit = async () => {
    setLoading(true);
    setRes(null);
    try {
      const input: LinkBudgetInput = {
        txPowerDbm: Number(form.txPowerDbm),
        cableLossDb: Number(form.cableLossDb),
        connectorLossDb: Number(form.connectorLossDb),
        antennaGainDbi: Number(form.antennaGainDbi),
        distanceM: Number(form.distanceM),
        frequencyMhz: form.frequencyMhz ? Number(form.frequencyMhz) : undefined,
        filterLossDb: form.filterLossDb ? Number(form.filterLossDb) : undefined,
        buildingLossDb: form.buildingLossDb ? Number(form.buildingLossDb) : undefined,
        foliageLossDb: form.foliageLossDb ? Number(form.foliageLossDb) : undefined,
        miscLossDb: form.miscLossDb ? Number(form.miscLossDb) : undefined,
        ueAntennaGainDbi: form.ueAntennaGainDbi ? Number(form.ueAntennaGainDbi) : undefined,
        propagationModel: model.propagationModel,
        txHeightM: form.txHeightM ? Number(form.txHeightM) : undefined,
        rxHeightM: form.rxHeightM ? Number(form.rxHeightM) : undefined,
        environment: model.propagationModel === 'hata' ? model.environment : undefined,
        cityType: (model.propagationModel === 'cost231-hata' || model.propagationModel === 'walfisch-ikegami') ? model.cityType : undefined,
        isLineOfSight: model.propagationModel === 'close-in' ? model.isLineOfSight : undefined,
        pathLossExponent: (model.propagationModel === 'close-in' || model.propagationModel === 'log-distance') && model.pathLossExponent
          ? Number(model.pathLossExponent) : undefined,
        logDistanceEnvironment: model.propagationModel === 'log-distance' ? model.logDistanceEnvironment : undefined,
        walfischIkegamiMode: model.propagationModel === 'walfisch-ikegami' ? model.walfischIkegamiMode : undefined,
        buildingHeightM: model.propagationModel === 'walfisch-ikegami' && model.buildingHeightM ? Number(model.buildingHeightM) : undefined,
        streetWidthM: model.propagationModel === 'walfisch-ikegami' && model.streetWidthM ? Number(model.streetWidthM) : undefined,
        buildingSeparationM: model.propagationModel === 'walfisch-ikegami' && model.buildingSeparationM ? Number(model.buildingSeparationM) : undefined,
        streetOrientationDeg: model.propagationModel === 'walfisch-ikegami' && model.streetOrientationDeg ? Number(model.streetOrientationDeg) : undefined,
      };
      const result = await rfPlanningApi.linkBudget(input);
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
      <div className="nms-card space-y-4 max-w-3xl w-full mx-auto">
        <p className="text-sm font-semibold text-nms-text">Radio & Path Inputs</p>
        <div className="grid grid-cols-2 gap-3">
          <NumField label="TX Power" value={form.txPowerDbm} onChange={set('txPowerDbm')} unit="dBm" />
          <NumField label="Antenna Gain" value={form.antennaGainDbi} onChange={set('antennaGainDbi')} unit="dBi" />
          <NumField label="Cable Loss" value={form.cableLossDb} onChange={set('cableLossDb')} unit="dB" />
          <NumField label="Connector Loss" value={form.connectorLossDb} onChange={set('connectorLossDb')} unit="dB" />
          <NumField label="Filter Loss" value={form.filterLossDb} onChange={set('filterLossDb')} unit="dB" placeholder="0" />
          <NumField label="Frequency" value={form.frequencyMhz} onChange={set('frequencyMhz')} unit="MHz" />
          <NumField label="Distance" value={form.distanceM} onChange={set('distanceM')} unit="m" />
          <NumField label="UE Antenna Gain" value={form.ueAntennaGainDbi} onChange={set('ueAntennaGainDbi')} unit="dBi" placeholder="0" />
          <NumField label="Building Loss" value={form.buildingLossDb} onChange={set('buildingLossDb')} unit="dB" placeholder="0" />
          <NumField label="Foliage Loss" value={form.foliageLossDb} onChange={set('foliageLossDb')} unit="dB" placeholder="0" />
          <NumField label="Misc Loss" value={form.miscLossDb} onChange={set('miscLossDb')} unit="dB" placeholder="0" />
        </div>
        <div className="grid grid-cols-3 gap-3 pt-3 border-t border-nms-border">
          <SelectField
            label="Propagation Model" value={model.propagationModel}
            onChange={v => setModel(m => ({ ...m, propagationModel: v as PropagationModel }))}
            options={[
              { value: 'fspl', label: 'Free-Space Path Loss' },
              { value: 'hata', label: 'Hata (150-1500 MHz, 30-200m towers)' },
              { value: 'cost231-hata', label: 'COST-231-Hata (1500-2000 MHz, 30-200m towers)' },
              { value: 'close-in', label: 'Close-In (any frequency/height — CBRS/small cell)' },
              { value: 'log-distance', label: 'Log-Distance (configurable exponent, general-purpose)' },
              { value: 'walfisch-ikegami', label: 'Walfisch-Ikegami (800-2000 MHz, urban street-level)' },
            ]}
          />
          {(model.propagationModel === 'hata' || model.propagationModel === 'cost231-hata' || model.propagationModel === 'walfisch-ikegami') && (
            <>
              <NumField label="TX (Base Station) Height" value={form.txHeightM} onChange={set('txHeightM')} unit="m" placeholder={model.propagationModel === 'walfisch-ikegami' ? '4-50' : '30-200'} />
              <NumField label="RX (Mobile) Height" value={form.rxHeightM} onChange={set('rxHeightM')} unit="m" placeholder={model.propagationModel === 'walfisch-ikegami' ? '1-3' : '1-10'} />
            </>
          )}
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
          {model.propagationModel === 'close-in' && (
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
                label="City Type" value={model.cityType}
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
        </div>
        <button onClick={submit} disabled={loading} className="nms-btn-primary w-full">
          {loading ? 'Calculating…' : 'Calculate Link Budget'}
        </button>
      </div>

      <div className="space-y-4 max-w-3xl w-full mx-auto">
        {res?.ok && res.result && (
          <div className="nms-card space-y-2">
            <p className="text-sm font-semibold text-nms-text mb-1">Result</p>
            <ResultLine label="EIRP" value={res.result.eirpDbm} unit="dBm" />
            <ResultLine label="Path Loss" value={res.result.pathLossDb} unit="dB" />
            <ResultLine label="Total Received Power" value={res.result.totalReceivedPowerDbm} unit="dBm" />
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
  );
}

export const RfPlanningPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('link-budget');

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold font-display text-nms-text flex items-center gap-2">
            <Radar className="w-6 h-6 text-nms-accent" />
            RF Planning
            <span
              className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider text-amber-400 bg-amber-500/10 border border-amber-500/30"
              title="Actively being built out — expect rough edges, incomplete phases, and possible breaking changes between releases"
            >
              Alpha
            </span>
          </h1>
          <p className="text-sm text-nms-text-dim mt-1">
            Deterministic link-budget and site-geometry calculations — every result traces back to a sourced equation.
            This module is in early, active development.
          </p>
        </div>
      </div>

      <div className="flex justify-center">
        <div className="flex gap-1 p-1 bg-nms-surface-2 rounded-lg border border-nms-border">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
                activeTab === tab.id
                  ? 'bg-nms-accent text-white shadow-sm'
                  : 'text-nms-text-dim hover:text-nms-text hover:bg-nms-surface',
              )}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'link-budget' && <LinkBudgetTab />}
      {activeTab === 'point-analysis' && <PointAnalysisTab />}
      {activeTab === 'coverage-map' && <CoverageMapTab />}
    </div>
  );
};
