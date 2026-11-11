// Local demonstration only. No API client, credentials, sockets or live state.
export type CoreId = 'A' | 'B';
export type SimUe = { imsi: string; ip: string; core: CoreId; anchor: CoreId; radio: string; voice: boolean; status: 'connected' | 'interrupted' };
export type PoolSimulation = { online: Record<CoreId, boolean>; ues: SimUe[]; events: string[] };
export const coreAddress = (core: CoreId) => core === 'A' ? '172.20.8.62' : '172.20.8.63';
export function initialPoolSimulation(): PoolSimulation {
  return { online: { A: true, B: true }, ues: [
    { imsi: '001010000000101', ip: '10.45.0.101', core: 'A', anchor: 'A', radio: 'eNB-A / TAC 1', voice: true, status: 'connected' },
    { imsi: '001010000000102', ip: '10.45.0.102', core: 'A', anchor: 'A', radio: 'eNB-A / TAC 1', voice: false, status: 'connected' },
    { imsi: '001010000000201', ip: '10.47.0.101', core: 'B', anchor: 'B', radio: 'eNB-B / TAC 2', voice: true, status: 'connected' },
  ], events: ['DEMO · Two active MMEs, separate radio sites and distinct GUMMEIs. All values are synthetic.'] };
}
export function simulateMobility(state: PoolSimulation, imsi: string, procedure: 'handover' | 'tau'): PoolSimulation {
  const ue = state.ues.find(u => u.imsi === imsi);
  if (!ue) return state;
  const target: CoreId = ue.core === 'A' ? 'B' : 'A';
  if (!state.online[ue.core] || !state.online[target] || !state.online[ue.anchor] || ue.status !== 'connected')
    return { ...state, events: [...state.events, 'DEMO · Mobility refused: source, target or retained PGW unavailable. Reset the scenario.'] };
  // TAU is an idle-mode example. Do not present it as a connected voice handover.
  if (procedure === 'tau' && ue.voice)
    return { ...state, events: [...state.events, 'DEMO · Choose a UE without an active call for idle TAU; use S1 handover for this call.'] };
  const steps = procedure === 'handover'
    ? ['S1AP Handover Required', 'S10 Forward Relocation Request / Response', 'Target radio preparation; SGW resources reserved', 'Handover Notify; existing PGW binding updated', 'S10 Forward Relocation Complete; old resources released']
    : ['Idle UE enters the other tracking area; TAU Request', 'S10 Context Request / Response / Acknowledge', 'Serving-MME registration at HSS; SGW path updated', 'TAU Accept; data resumes on the retained PDN'];
  return { ...state, ues: state.ues.map(u => u.imsi === imsi ? { ...u, core: target, radio: `eNB-${target} / TAC ${target === 'A' ? 1 : 2}` } : u),
    events: [...state.events, ...steps.map(s => `DEMO · ${imsi} · ${s}`), `DEMO · ${imsi} · MME ${target}, retained PGW ${ue.anchor}, unchanged IP ${ue.ip}.`] };
}
export function simulateCoreFailure(state: PoolSimulation, failed: CoreId): PoolSimulation {
  return { ...state, online: { ...state.online, [failed]: false },
    ues: state.ues.map(u => u.core === failed || u.anchor === failed ? { ...u, status: 'interrupted' } : u),
    events: [...state.events, `DEMO · Core ${failed} unavailable. Sessions using its MME or PGW marked interrupted; no seamless recovery is simulated.`] };
}
