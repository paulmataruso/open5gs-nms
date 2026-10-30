import { useCallback, useEffect, useState } from 'react';
import { Shield, RefreshCw, ExternalLink } from 'lucide-react';
import { sasApi, type SasStatus, type SasCbsd } from '../api/sas';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MSheet, MFacts,
  MEmpty, MIconButton, MLoading, fmtAgo,
} from './MobileKit';

/**
 * CBRS SAS, built for a phone.
 *
 * Read-only, which is not a mobile compromise — the desktop page is read-only
 * too. The NMS does not implement a SAS; SASBench does, and this is a view
 * onto its REST API.
 *
 * The desktop page's centrepiece is the band-occupancy chart: a frequency axis
 * with one stacked lane per radio. That needs horizontal room to mean anything
 * — at 375px, 150 MHz across ~340 usable pixels puts nine overlapping grants
 * inside a few pixels each. So the chart is left on the desktop and the three
 * numbers it exists to communicate are shown directly instead: distinct
 * spectrum in use, peak overlap depth (the figure that actually predicts
 * co-channel contention) and the largest free run.
 *
 * Occupancy deliberately shows the NMS-derived union, NOT SASBench's own
 * authorizedMHz: on GAA the SAS authorises overlapping grants by design, so
 * that figure routinely exceeds the band itself and answers "how much did we
 * hand out" rather than "how much of the band is in use".
 */
export function MobileSasPage(): JSX.Element {
  const [status, setStatus] = useState<SasStatus | null>(null);
  const [cbsds, setCbsds] = useState<SasCbsd[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sheet, setSheet] = useState<SasCbsd | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [st, cb] = await Promise.allSettled([sasApi.getStatus(), sasApi.getCbsds()]);
    setStatus(st.status === 'fulfilled' ? st.value : null);
    setCbsds(cb.status === 'fulfilled' && cb.value.reachable ? cb.value.cbsds : []);
    setRefreshing(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 30_000);
    return () => clearInterval(id);
  }, [load]);

  if (loading) {
    return <MScreen title="SAS"><MLoading label="Reading SASBench" /></MScreen>;
  }

  if (!status || !status.reachable) {
    return (
      <MScreen title="SAS">
        <MEmpty icon={Shield} title="SASBench unreachable"
          hint={status?.error ?? 'The SAS did not answer. Radios keep their current grants meanwhile.'} />
      </MScreen>
    );
  }

  const occ = status.derived?.occupancy;

  return (
    <MScreen title="SAS">
      <MStatGrid>
        <MStat label="CBSDs" value={`${status.counts?.cbsdsRegistered ?? 0}/${status.counts?.cbsdsTotal ?? 0}`}
          tone={(status.counts?.cbsdsPending ?? 0) > 0 ? 'warn' : 'ok'} sub="registered" />
        <MStat label="Live grants" value={occ?.liveGrants ?? 0} tone="accent"
          sub={status.derived ? `${status.derived.radiosWithGrant} radios` : undefined} />
        <MStat label="Band in use" value={occ ? `${Math.round(occ.distinctMHz)} MHz` : '—'} tone="accent"
          sub={occ ? `${Math.round(occ.occupancyPct)}% of ${Math.round(occ.bandMHz)} MHz` : undefined} />
        <MStat label="Peak overlap" value={occ?.maxOverlap ?? '—'}
          tone={(occ?.maxOverlap ?? 1) > 1 ? 'warn' : 'ok'}
          sub={(occ?.maxOverlap ?? 1) > 1 ? 'grants co-channel' : 'nothing co-channel'} />
      </MStatGrid>

      {occ && (
        <MSection title="Spectrum">
          <MRows>
            <MRow title="Largest free run" subtitle={`${Math.round(occ.largestGapMHz)} MHz contiguous and unused`} />
            <MRow title="Handed out" subtitle={`${Math.round(occ.grantedMHz)} MHz of grant widths summed`}
              meta={occ.grantedMHz > occ.bandMHz
                ? <MBadge tone="muted">exceeds the band — grants overlap by design on GAA</MBadge>
                : undefined} />
            <MRow title="Profile" subtitle={status.profile ?? 'no named preset'} />
          </MRows>
        </MSection>
      )}

      <MSection
        title={`Radios (${cbsds.length})`}
        right={
          <MIconButton label="Refresh SAS status" icon={RefreshCw} spinning={refreshing}
            onPress={() => void load()} />
        }
      >
        {cbsds.length === 0 ? (
          <MEmpty icon={Shield} title="No CBSDs" hint="No radio has registered with the SAS." />
        ) : (
          <MRows>
            {cbsds.map(c => {
              const live = (c.grants.GRANTED ?? 0) + (c.grants.AUTHORIZED ?? 0);
              return (
                <MRow
                  key={c.cbsdId}
                  tone={c.state === 'REGISTERED' ? (live > 0 ? 'ok' : 'warn') : 'bad'}
                  title={c.serial || c.cbsdId}
                  subtitle={c.fccId}
                  meta={
                    <>
                      <MBadge tone={c.state === 'REGISTERED' ? 'ok' : 'warn'}>{c.state}</MBadge>
                      <MBadge tone={live > 0 ? 'accent' : 'muted'}>{live} grant{live === 1 ? '' : 's'}</MBadge>
                      {c.category && <MBadge tone="muted">Cat {c.category}</MBadge>}
                    </>
                  }
                  onPress={() => setSheet(c)}
                  ariaLabel={`${c.serial || c.cbsdId}, ${c.state}, ${live} grants`}
                />
              );
            })}
          </MRows>
        )}
      </MSection>

      <MSheet
        open={sheet !== null}
        title={sheet?.serial || sheet?.cbsdId || 'CBSD'}
        subtitle={sheet?.fccId}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <MFacts rows={[
            { label: 'CBSD ID', value: sheet.cbsdId, mono: true },
            { label: 'FCC ID', value: sheet.fccId, mono: true },
            { label: 'Serial', value: sheet.serial, mono: true },
            { label: 'State', value: sheet.state },
            { label: 'Category', value: sheet.category ?? '—' },
            { label: 'Address', value: sheet.remoteAddr ?? '—', mono: true },
            { label: 'Transport', value: sheet.transport ?? '—' },
            { label: 'Last seen', value: sheet.lastSeen ? `${fmtAgo(sheet.lastSeen)} ago` : '—' },
            {
              label: 'Grants',
              value: Object.entries(sheet.grants).length === 0
                ? 'none'
                : Object.entries(sheet.grants).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', '),
            },
          ]} />
        )}
      </MSheet>

      <p className="flex items-start gap-1.5 text-[11px] text-nms-text-dim">
        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        The band-occupancy chart, grant detail and SASBench's own admin UI are on the
        desktop SAS page.
      </p>
    </MScreen>
  );
}
