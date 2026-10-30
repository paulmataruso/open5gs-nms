import { Monitor, ArrowLeft } from 'lucide-react';
import { navLabelFor } from '../components/common/navItems';
import { MScreen, MCard, MRows, MRow } from './MobileKit';
import { mobileNavItems } from './mobileNav';

/**
 * Shown when a destination with no mobile page is open on a phone.
 *
 * This exists rather than hiding those destinations outright, or silently
 * redirecting to the dashboard. Both of those alternatives are worse in a
 * specific way: a missing destination is indistinguishable from a feature
 * that is switched off (several modules here genuinely can be), and a silent
 * redirect looks like the tap failed. Saying plainly "this one needs a
 * desktop" is the only option that does not read as a bug.
 *
 * It is also reachable without a tap: an operator who had Configuration open
 * on a desktop and then rotated a tablet into portrait crosses 768px, and the
 * nav state is preserved across that boundary by design.
 */
export function NeedsDesktopPage(
  { tabId, onNavigate }: { tabId: string; onNavigate: (tab: string) => void },
): JSX.Element {
  const label = navLabelFor(tabId);
  const available = mobileNavItems();

  return (
    <MScreen title={label}>
      <MCard>
        <div className="flex flex-col items-center px-2 py-6 text-center">
          <Monitor className="mb-3 h-8 w-8 text-nms-text-dim opacity-60" aria-hidden="true" />
          <p className="font-display text-base font-semibold text-nms-text">
            {label} needs a desktop
          </p>
          <p className="mt-2 text-xs leading-relaxed text-nms-text-dim">
            This page is a sit-down task — the kind with a wide editor, a map, a
            multi-step wizard or a long apply step. It is deliberately not given a
            phone layout rather than shipped as a cramped one, because a
            half-finished change here is a real network change, not a cosmetic
            problem.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-nms-text-dim">
            It is fully available on a desktop browser at the same address.
          </p>
        </div>
      </MCard>

      <div className="space-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-nms-text-dim">
          Available on mobile
        </h2>
        <MRows>
          {available.map(item => (
            <MRow
              key={item.id}
              title={item.label}
              onPress={() => onNavigate(item.id)}
              ariaLabel={`Go to ${item.label}`}
            />
          ))}
        </MRows>
      </div>

      <button
        type="button"
        onClick={() => onNavigate('dashboard')}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-nms-border-strong bg-nms-surface text-xs font-medium text-nms-text active:bg-nms-surface-2"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Dashboard
      </button>
    </MScreen>
  );
}
