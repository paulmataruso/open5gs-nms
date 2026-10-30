import { useCallback, useEffect, useState } from 'react';
import { PhoneCall, PhoneOff, RefreshCw } from 'lucide-react';
import { cdrApi, type CdrRecord } from '../api';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MChips, MSheet, MFacts,
  MEmpty, MIconButton, MLoading, type Tone,
} from './MobileKit';

/**
 * Call History, built for a phone.
 *
 * Unified CDRs across PSTN, 2G and direct 4G/5G IMS. The desktop page adds a
 * date-range picker, retention settings and the Direct IMS Call Recording
 * toggle — settings, not reading, so they stay there.
 *
 * Two things worth knowing about what is shown. A voicemail pickup is
 * indistinguishable from a human answer at the SIP level (both are real
 * 2xx-terminated INVITE transactions), so "answered" means exactly that and
 * nothing more. And one PSTN call legitimately appears as TWO rows: Asterisk
 * is a real B2BUA, so a call through it is two separate dialogs with their own
 * Call-IDs, each with its own CDR. Neither is a bug and the footnote says so,
 * because both look like one on a small list.
 */

type Filter = 'all' | 'answered' | 'missed';

const DISPOSITION_TONE: Record<CdrRecord['disposition'], Tone> = {
  answered: 'ok',
  'no-answer': 'warn',
  busy: 'warn',
  failed: 'bad',
  cancelled: 'muted',
  unknown: 'muted',
};

function fmtDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

function party(p: CdrRecord['caller'] | CdrRecord['callee']): string {
  return p.nickname || p.msisdn || p.imsi || p.raw || '—';
}

export function MobileCallHistoryPage(): JSX.Element {
  const [rows, setRows] = useState<CdrRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<CdrRecord | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      // Server-side paging at 50; this view is "recent calls", not an archive
      // browser, so there is no pager — the desktop page has the date range.
      const r = await cdrApi.list({ page: 1, pageSize: 50 });
      setRows(r.rows);
      setTotal(r.total);
    } catch {
      setRows([]);
      setTotal(0);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const shown = rows.filter(r => {
    if (filter === 'answered') return r.disposition === 'answered';
    if (filter === 'missed') return r.disposition !== 'answered';
    return true;
  });

  const answered = rows.filter(r => r.disposition === 'answered').length;

  if (loading) {
    return <MScreen title="Call History"><MLoading label="Reading call records" /></MScreen>;
  }

  return (
    <MScreen title="Call History">
      <MStatGrid>
        <MStat label="Recent calls" value={rows.length} tone="accent"
          sub={total > rows.length ? `${total} total recorded` : 'all recorded'} />
        <MStat label="Answered" value={answered} tone={answered > 0 ? 'ok' : 'muted'}
          sub={`${rows.length - answered} not answered`} />
      </MStatGrid>

      <MChips ariaLabel="Filter calls" value={filter} onChange={setFilter}
        options={[
          { value: 'all', label: 'All', count: rows.length },
          { value: 'answered', label: 'Answered', count: answered },
          { value: 'missed', label: 'Not answered', count: rows.length - answered },
        ]} />

      <MSection
        title={`${shown.length} call${shown.length === 1 ? '' : 's'}`}
        right={
          <MIconButton label="Refresh call history" icon={RefreshCw} spinning={refreshing}
            onPress={() => void load()} />
        }
      >
        {shown.length === 0 ? (
          <MEmpty icon={PhoneCall} title="No calls recorded"
            hint="Nothing has been synced into the CDR store yet." />
        ) : (
          <MRows>
            {shown.map(r => (
              <MRow
                key={r._id}
                tone={DISPOSITION_TONE[r.disposition]}
                title={`${party(r.caller)} → ${party(r.callee)}`}
                subtitle={new Date(r.startTime).toLocaleString()}
                meta={
                  <>
                    <MBadge tone={DISPOSITION_TONE[r.disposition]}>{r.disposition}</MBadge>
                    <MBadge tone="muted">{r.sourceSystem.toUpperCase()}</MBadge>
                    {r.disposition === 'answered' && (
                      <MBadge tone="muted">{fmtDuration(r.durationSeconds)}</MBadge>
                    )}
                  </>
                }
                onPress={() => setSheet(r)}
                ariaLabel={`Call from ${party(r.caller)} to ${party(r.callee)}, ${r.disposition}`}
              />
            ))}
          </MRows>
        )}
      </MSection>

      <MSheet
        open={sheet !== null}
        title={sheet ? `${party(sheet.caller)} → ${party(sheet.callee)}` : 'Call'}
        subtitle={sheet ? new Date(sheet.startTime).toLocaleString() : undefined}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <MFacts rows={[
            { label: 'From', value: party(sheet.caller), mono: true },
            { label: 'From IMSI', value: sheet.caller.imsi ?? '—', mono: true },
            { label: 'To', value: party(sheet.callee), mono: true },
            { label: 'To IMSI', value: sheet.callee.imsi ?? '—', mono: true },
            { label: 'Disposition', value: `${sheet.disposition} (${sheet.rawDisposition})` },
            { label: 'Started', value: new Date(sheet.startTime).toLocaleString() },
            { label: 'Answered', value: sheet.answerTime ? new Date(sheet.answerTime).toLocaleString() : 'never' },
            { label: 'Ended', value: sheet.endTime ? new Date(sheet.endTime).toLocaleString() : '—' },
            { label: 'Talk time', value: fmtDuration(sheet.durationSeconds) },
            { label: 'Total', value: fmtDuration(sheet.totalDurationSeconds) },
            { label: 'Source', value: `${sheet.sourceSystem} / ${sheet.sourceInstance}` },
          ]} />
        )}
      </MSheet>

      <p className="flex items-start gap-1.5 text-[11px] text-nms-text-dim">
        <PhoneOff className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        A call through the Voice Gateway is a real B2BUA and appears as two rows, one
        per dialog. A voicemail pickup is recorded as answered — it is indistinguishable
        from a human answer at the SIP level.
      </p>
    </MScreen>
  );
}
