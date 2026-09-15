import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { gsmApi, type HlrSubscriberStatus } from '../api/gsm';
import { smsApi } from '../api/sms';

function AuthBadge({ has }: { has: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border',
      has ? 'bg-green-500/10 text-green-400 border-green-500/30' : 'bg-nms-surface-2 text-nms-text-dim border-nms-border')}>
      {has ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {has ? 'Keyed' : 'No keys'}
    </span>
  );
}

// OsmoHLR stores last_lu_seen/last_lu_seen_ps as a plain UTC-seconds string
// with no offset marker — appending 'Z' is required or the Date parses it
// as local time and every timestamp shown is wrong by the host's own
// timezone offset.
function formatLu(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts.replace(' ', 'T') + 'Z');
  if (isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

// One shared auc_3g/OsmoHLR auth-status view, used as a tab from BOTH the
// 2G GSM page and the 3G UMTS page — not two separate features. There is
// only one HLR row per subscriber (the "Enable 2G/3G Auth" checkbox on the
// main Subscriber page, gsmEnabled), and OsmoHLR's own auc_3g table serves
// both 2G's GSM-AKA-compatible Milenage and full 3G UMTS AKA from that same
// row (confirmed via OsmoHLR's own manual) — so a 2G-only or 3G-only
// subscriber list would just be the identical data shown twice under a
// misleadingly narrower label. Previously its own top-level page
// (Gsm2gSubscribersPage.tsx / sidebar "2G Subscribers"); moved here so it
// reads correctly from either module's own page instead of a separate nav
// entry implying it's 2G-specific.
export function SubscriberAuthTab({ onNavigate }: { onNavigate?: (tab: string) => void }) {
  const [subscribers, setSubscribers] = useState<HlrSubscriberStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await gsmApi.listSubscribers();
      setSubscribers(r.subscribers);
    } catch {
      toast.error('Failed to load 2G/3G subscriber auth status.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await smsApi.syncSubscribers();
      toast.success(`Synced ${r.synced} subscriber${r.synced !== 1 ? 's' : ''} to the 2G/3G HLR${r.removed ? ` · removed ${r.removed} stale` : ''}`);
      await refresh();
    } catch (err: any) {
      toast.error(`Sync failed: ${err?.response?.data?.error ?? err.message}`);
    } finally {
      setSyncing(false);
    }
  };

  const keyedCount = subscribers?.filter(s => s.hasAuthKeys).length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-sm text-nms-text-dim">
          Real 2G/3G authentication status for every Open5GS subscriber, synced into OsmoHLR.
        </p>
        <div className="flex items-center gap-2">
          <button className="nms-btn-ghost" onClick={refresh} disabled={loading} title="Refresh">
            <RefreshCw className={clsx('w-4 h-4', loading && 'animate-spin')} />
          </button>
          <button className="nms-btn-primary" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Subscribers to HLR'}
          </button>
        </div>
      </div>

      <div className="bg-nms-surface-2 border border-nms-border rounded-lg p-3 text-xs text-nms-text-dim">
        This is the same subscriber database used by 4G/5G — there is no separate 2G or 3G
        subscriber list, since both share the exact same OsmoHLR auc_3g row. A subscriber is
        synced here if it has an MSISDN, <em>or</em> if you check its "Enable 2G/3G Auth" box on
        the{' '}
        <button className="text-nms-accent hover:underline" onClick={() => onNavigate?.('subscribers')}>
          Subscribers
        </button>{' '}
        page — then come back here and sync.
      </div>

      <div className="nms-card overflow-hidden !p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-nms-surface-2 text-nms-text-dim text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">IMSI</th>
                <th className="text-left px-4 py-2">MSISDN</th>
                <th className="text-left px-4 py-2">2G/3G Auth</th>
                <th className="text-left px-4 py-2">Last CS Attach</th>
                <th className="text-left px-4 py-2">Last PS Attach</th>
              </tr>
            </thead>
            <tbody>
              {subscribers?.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-nms-text-dim">
                  No subscribers in the 2G/3G HLR yet — sync from above.
                </td></tr>
              )}
              {subscribers?.map(s => (
                <tr key={s.imsi} className="border-t border-nms-border">
                  <td className="px-4 py-2 font-mono">{s.imsi}</td>
                  <td className="px-4 py-2 font-mono">{s.msisdn || '—'}</td>
                  <td className="px-4 py-2"><AuthBadge has={s.hasAuthKeys} /></td>
                  <td className="px-4 py-2 text-nms-text-dim">{formatLu(s.lastLuSeenCs)}</td>
                  <td className="px-4 py-2 text-nms-text-dim">{formatLu(s.lastLuSeenPs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {subscribers && subscribers.length > 0 && (
        <p className="text-xs text-nms-text-dim">
          {keyedCount} of {subscribers.length} subscriber(s) have real 2G/3G authentication key
          material — only those can actually attach over a real BTS or HNB.
        </p>
      )}
    </div>
  );
}
