import { useEffect, useState } from 'react';
import { FolderOpen, Save, Loader2, Plus } from 'lucide-react';
import { rfPlanningProjectsApi } from '../../api/rfPlanning';
import type { RfPlanningProject, RfPlanningSite } from '../../api/rfPlanning';
import type { PlanningRadio } from '../../api/rfSimulation';

// Project load/save for the planning workspace.
//
// This exists because saved projects predate the rewrite and hold real work:
// the server-side store already had projects with sites and survey points when
// this page was redesigned, and dropping the client would have left that data
// reachable only through the database. The site schema maps almost field for
// field onto a planning radio, so the translation is mechanical rather than
// lossy — the fields a site carries that this workspace does not yet expose
// (per-model terrain parameters, Fresnel thresholds) are preserved untouched on
// save rather than being silently reset to defaults.

interface Props {
  radios: PlanningRadio[];
  onLoad: (radios: PlanningRadio[], projectName: string) => void;
  onMessage: (kind: 'error' | 'info', text: string) => void;
}

/** A saved site becomes a planning radio. */
export function siteToRadio(site: RfPlanningSite): PlanningRadio {
  const frequencyGhz = site.frequencyMhz ? site.frequencyMhz / 1000 : 3.6;
  return {
    id: site.id,
    // The saved schema has no concept of a multi-sector site, so each stored
    // site loads as its own single-sector site. Grouping them afterwards would
    // mean guessing which ones share a mast from their coordinates, and a
    // wrong guess would make one radio's edits silently move another.
    siteId: site.id,
    siteName: site.name,
    sectorLabel: 'Omni',
    name: site.name,
    latitude: site.siteLat,
    longitude: site.siteLon,
    azimuthDeg: site.azimuthDeg,
    // Saved projects predate the technology field; infer from frequency so a
    // 3.5 GHz CBRS site loads as 5G rather than defaulting to LTE.
    technology: frequencyGhz >= 3 ? '5g' : '4g',
    frequencyGhz,
    bandwidthMhz: 20,
    txPowerDbm: site.txPowerDbm,
    txAntennaGainDbi: site.antennaGainDbi,
    antennaHeightM: site.siteHeightM,
    beamWidthDeg: site.horizontalBeamwidthDeg,
    mechanicalDowntiltDeg: site.mechanicalDowntiltDeg ?? 0,
    receiverSensitivityDbm: -110,
    receiverHeightM: site.receiverHeightM ?? 1.5,
    loadFactor: 0.7,
  };
}

/**
 * Merge a planning radio back onto its original site, keeping every field this
 * workspace does not edit. Round-tripping through a fresh object would quietly
 * discard the propagation-model and terrain settings a site may carry.
 */
export function radioToSite(radio: PlanningRadio, original?: RfPlanningSite): RfPlanningSite {
  return {
    ...(original ?? {
      id: radio.id, name: radio.name,
      siteLat: radio.latitude, siteLon: radio.longitude, siteHeightM: radio.antennaHeightM,
      azimuthDeg: radio.azimuthDeg, horizontalBeamwidthDeg: radio.beamWidthDeg,
      txPowerDbm: radio.txPowerDbm, cableLossDb: 0, connectorLossDb: 0,
      antennaGainDbi: radio.txAntennaGainDbi,
    }),
    id: radio.id,
    name: radio.name,
    siteLat: radio.latitude,
    siteLon: radio.longitude,
    siteHeightM: radio.antennaHeightM,
    azimuthDeg: radio.azimuthDeg,
    horizontalBeamwidthDeg: radio.beamWidthDeg,
    mechanicalDowntiltDeg: radio.mechanicalDowntiltDeg,
    txPowerDbm: radio.txPowerDbm,
    antennaGainDbi: radio.txAntennaGainDbi,
    frequencyMhz: Math.round(radio.frequencyGhz * 1000),
    receiverHeightM: radio.receiverHeightM,
  };
}

export function ProjectBar({ radios, onLoad, onMessage }: Props) {
  const [projects, setProjects] = useState<RfPlanningProject[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rfPlanningProjectsApi.list()
      .then(list => { if (!cancelled) { setProjects(list); setLoaded(true); } })
      .catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  async function load(id: string) {
    if (!id) return;
    setBusy(true);
    try {
      const project = await rfPlanningProjectsApi.get(id);
      const sites = project.sites ?? [];
      if (sites.length === 0) {
        onMessage('info', `"${project.name}" has no sites saved yet.`);
      } else {
        onLoad(sites.map(siteToRadio), project.name);
        onMessage('info', `Loaded ${sites.length} radio(s) from "${project.name}".`);
      }
      setActiveId(id);
    } catch (err) {
      onMessage('error', `Could not load project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (radios.length === 0) { onMessage('error', 'Nothing to save — place a radio first.'); return; }
    setBusy(true);
    try {
      let projectId = activeId;
      let projectName = projects.find(p => p.id === activeId)?.name ?? '';
      if (!projectId) {
        const name = window.prompt('Project name', `Plan ${new Date().toISOString().slice(0, 10)}`);
        if (!name) { setBusy(false); return; }
        const created = await rfPlanningProjectsApi.create(name);
        projectId = created.id;
        projectName = created.name;
        setProjects(current => [...current, created]);
        setActiveId(created.id);
      }
      const existing = await rfPlanningProjectsApi.get(projectId);
      const bySiteId = new Map((existing.sites ?? []).map(s => [s.id, s]));
      await rfPlanningProjectsApi.update(projectId, {
        sites: radios.map(radio => radioToSite(radio, bySiteId.get(radio.id))),
      });
      onMessage('info', `Saved ${radios.length} radio(s) to "${projectName}".`);
    } catch (err) {
      onMessage('error', `Could not save project: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="rf-project" className="sr-only">Project</label>
      <div className="flex items-center gap-1.5">
        <FolderOpen className="w-4 h-4 text-nms-text-dim" aria-hidden="true" />
        <select
          id="rf-project"
          className="nms-input text-sm max-w-[12rem]"
          value={activeId}
          disabled={busy || !loaded}
          onChange={e => load(e.target.value)}
        >
          <option value="">
            {loaded ? (projects.length ? 'Open a project…' : 'No saved projects') : 'Loading…'}
          </option>
          {projects.map(project => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </div>
      <button
        type="button" onClick={save} disabled={busy || radios.length === 0}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs border border-nms-border-strong hover:bg-nms-surface disabled:opacity-50"
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
              : activeId ? <Save className="w-3.5 h-3.5" aria-hidden="true" />
              : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
        {activeId ? 'Save' : 'Save as…'}
      </button>
    </div>
  );
}
