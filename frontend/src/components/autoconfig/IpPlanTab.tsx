import { IpPlanPanel } from '../common/IpPlanPanel';

// "Propose IP Plan" -> review a current-vs-proposed diff -> "Apply Plan".
// Deliberately two explicit steps, nothing automatic: this tool exists to
// mass-plan/mass-change IPs in one place instead of visiting every module's
// own page, but it must never silently write anything — a module's IP only
// ever changes here when the operator reviews a proposal and applies it.
// The actual propose/review/apply mechanic lives in IpPlanPanel (shared
// with the Full Backup Restore flow's own "re-address this host" step) —
// this component is just this page's own card/header framing around it.
export function IpPlanTab() {
  return (
    <div className="space-y-6">
      <div className="nms-card">
        <div className="mb-2">
          <h2 className="text-sm font-semibold text-nms-text">Static IP Plan</h2>
          <p className="text-xs text-nms-text-dim mt-1 max-w-2xl">
            Mass-plan every static IP the system could need — including modules you haven't
            installed yet — instead of visiting each module's own page. Nothing here ever
            changes a module's real config except an explicit Apply Plan run.
          </p>
        </div>
        <IpPlanPanel />
      </div>
    </div>
  );
}
