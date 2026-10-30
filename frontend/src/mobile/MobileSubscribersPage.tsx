import { useCallback, useEffect, useMemo, useState } from 'react';
import { Users, ChevronLeft, ChevronRight, Smartphone } from 'lucide-react';
import { subscriberApi } from '../api';
import type { SubscriberListItem } from '../types';
import {
  MScreen, MSection, MRows, MRow, MBadge, MSheet, MFacts, MEmpty, MLoading, MSearch,
} from './MobileKit';

/**
 * Subscribers, built for a phone.
 *
 * Read and look up, not edit. The desktop page is a wide table with inline
 * editing, bulk selection, group assignment, CSV import/export and an
 * auto-assign wizard — all genuinely sit-down tasks, and a half-finished
 * subscriber edit made one-thumbed on a train is a real provisioning problem,
 * not a cosmetic one. So this page answers "who is this IMSI and what is it
 * configured with", which is what gets asked away from a desk.
 *
 * Paging is server-side at 50 per page, the same as the desktop store's own
 * page size, and search goes to the server rather than filtering the current
 * page — otherwise searching would silently only look at the 50 rows in hand.
 */

const PAGE_SIZE = 50;

export function MobileSubscribersPage(): JSX.Element {
  const [rows, setRows] = useState<SubscriberListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<SubscriberListItem | null>(null);

  // Debounced so typing an IMSI does not fire a request per keystroke.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => { setDebouncedQ(q); setPage(0); }, 300);
    return () => clearTimeout(id);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await subscriberApi.list(page * PAGE_SIZE, PAGE_SIZE, debouncedQ || undefined);
      setRows(r.subscribers);
      setTotal(r.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, debouncedQ]);

  useEffect(() => { void load(); }, [load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const sessions = useMemo(() => sheet?.sessions ?? [], [sheet]);

  return (
    <MScreen title="Subscribers">
      <MSearch value={q} onChange={setQ} label="Search subscribers"
        placeholder="IMSI, nickname or MSISDN…" />

      <MSection title={total === 0 ? 'Subscribers' : `${total} subscriber${total === 1 ? '' : 's'}`}>
        {loading ? (
          <MLoading label="Loading subscribers" />
        ) : rows.length === 0 ? (
          <MEmpty icon={Users} title={debouncedQ ? 'Nothing matches' : 'No subscribers'}
            hint={debouncedQ ? `Nothing matches “${debouncedQ}”.` : 'None are provisioned yet.'} />
        ) : (
          <MRows>
            {rows.map(s => (
              <MRow
                key={s.imsi}
                title={s.nickname || s.imsi}
                subtitle={s.nickname ? s.imsi : (s.msisdn?.[0] || s.ue_ipv4 || undefined)}
                meta={
                  <>
                    {s.apn && <MBadge tone="muted">{s.apn}</MBadge>}
                    {s.session_count > 1 && <MBadge tone="muted">{s.session_count} sessions</MBadge>}
                    {s.simType === 'esim' && <MBadge tone="accent">eSIM</MBadge>}
                  </>
                }
                onPress={() => setSheet(s)}
                ariaLabel={`Subscriber ${s.imsi}`}
              />
            ))}
          </MRows>
        )}
      </MSection>

      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setPage(p => Math.max(0, p - 1))}
            disabled={page === 0}
            className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl border border-nms-border-strong bg-nms-surface text-xs font-medium text-nms-text active:bg-nms-surface-2 disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />Previous
          </button>
          <span className="shrink-0 px-1 text-xs tabular-nums text-nms-text-dim">
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl border border-nms-border-strong bg-nms-surface text-xs font-medium text-nms-text active:bg-nms-surface-2 disabled:opacity-40"
          >
            Next<ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <MSheet
        open={sheet !== null}
        title={sheet?.nickname || sheet?.imsi || 'Subscriber'}
        subtitle={sheet?.nickname ? sheet.imsi : undefined}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <>
            <MFacts rows={[
              { label: 'IMSI', value: sheet.imsi, mono: true },
              { label: 'MSISDN', value: sheet.msisdn?.length ? sheet.msisdn.join(', ') : '—', mono: true },
              { label: 'ICCID', value: sheet.iccid || '—', mono: true },
              { label: 'SIM', value: sheet.simType ?? '—' },
              { label: 'UE IPv4', value: sheet.ue_ipv4 || '—', mono: true },
              { label: 'Slices', value: sheet.slice_count },
              { label: 'Sessions', value: sheet.session_count },
            ]} />

            {sessions.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-nms-text-dim">
                  Sessions
                </p>
                <MRows>
                  {sessions.map((sess, i) => (
                    <MRow
                      key={`${sess.apn}-${i}`}
                      title={sess.apn}
                      subtitle={sess.ipv4 || 'no static address'}
                      meta={sess.framedRoutes?.length
                        ? <MBadge tone="muted">{sess.framedRoutes.length} framed route{sess.framedRoutes.length === 1 ? '' : 's'}</MBadge>
                        : undefined}
                    />
                  ))}
                </MRows>
              </div>
            )}

            <p className="flex items-start gap-1.5 text-[11px] text-nms-text-dim">
              <Smartphone className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              Editing, group assignment and IP auto-assign are desktop tasks — open this
              subscriber on a desktop to change it.
            </p>
          </>
        )}
      </MSheet>
    </MScreen>
  );
}
