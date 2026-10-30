import { useCallback, useEffect, useMemo, useState } from 'react';
import { TrendingUp, ArrowDown, ArrowUp } from 'lucide-react';
import { trafficHistoryApi, type TrafficHistoryPoint } from '../api';
import {
  MScreen, MSection, MStatGrid, MStat, MCard, MChips, MEmpty, MLoading, fmtMbps,
} from './MobileKit';

/**
 * Traffic History, built for a phone.
 *
 * The desktop page is a recharts time series with a zoomable brush, a radio
 * filter, a RAN-generation filter, a DNN filter and a per-subscriber selector.
 * A brush needs a drag target wider than a thumb and a legend that does not
 * eat half the plot, so this does not reuse it.
 *
 * Instead: the numbers that actually get checked (peak and current throughput
 * over the window) plus a bar strip drawn with divs. No chart library on the
 * mobile path at all — recharts is ~90KB of the initial parse budget, and this
 * view needs a shape, not interactivity. The bars are presentational and the
 * real values are in the stats above them and in each bar's own title, so
 * nothing is conveyed by the picture alone.
 */

type Window = '1h' | '6h' | '24h';

const WINDOWS: ReadonlyArray<{ value: Window; label: string; hours: number; resolution: '5m' | '15m' | '1h' }> = [
  { value: '1h', label: 'Last hour', hours: 1, resolution: '5m' },
  { value: '6h', label: '6 hours', hours: 6, resolution: '15m' },
  { value: '24h', label: '24 hours', hours: 24, resolution: '1h' },
];

export function MobileTrafficHistoryPage(): JSX.Element {
  const [win, setWin] = useState<Window>('6h');
  const [points, setPoints] = useState<TrafficHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const spec = WINDOWS.find(w => w.value === win)!;
    setLoading(true);
    setFailed(false);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - spec.hours * 3600_000);
      const r = await trafficHistoryApi.query({
        scope: 'aggregate',
        resolution: spec.resolution,
        from: from.toISOString(),
        to: to.toISOString(),
      });
      setPoints(r.points);
    } catch {
      setPoints([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [win]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Points arrive per-DNN, so several share one timestamp. Summing by
   * timestamp is what makes "total throughput" mean the whole network rather
   * than whichever DNN happened to sort last.
   */
  const series = useMemo(() => {
    const byTs = new Map<string, { up: number; down: number }>();
    for (const p of points) {
      const cur = byTs.get(p.ts) ?? { up: 0, down: 0 };
      cur.up += p.upMbps;
      cur.down += p.downMbps;
      byTs.set(p.ts, cur);
    }
    return [...byTs.entries()]
      .map(([ts, v]) => ({ ts, ...v }))
      .sort((a, b) => a.ts.localeCompare(b.ts));
  }, [points]);

  const peakDown = series.reduce((m, p) => Math.max(m, p.down), 0);
  const peakUp = series.reduce((m, p) => Math.max(m, p.up), 0);
  const latest = series.length > 0 ? series[series.length - 1] : null;
  const scale = Math.max(peakDown, peakUp, 0.001);

  return (
    <MScreen title="Traffic History">
      <MChips ariaLabel="Time window" value={win} onChange={setWin}
        options={WINDOWS.map(w => ({ value: w.value, label: w.label }))} />

      {loading ? (
        <MLoading label="Querying Prometheus" />
      ) : failed ? (
        <MEmpty icon={TrendingUp} title="Could not read history"
          hint="Prometheus did not answer. It is the store behind this view." />
      ) : series.length === 0 ? (
        <MEmpty icon={TrendingUp} title="No traffic recorded"
          hint="Nothing was sampled in this window." />
      ) : (
        <>
          <MStatGrid>
            <MStat label="Now ↓" value={fmtMbps(latest?.down ?? 0)} tone="accent" sub="downlink" />
            <MStat label="Now ↑" value={fmtMbps(latest?.up ?? 0)} tone="accent" sub="uplink" />
            <MStat label="Peak ↓" value={fmtMbps(peakDown)} tone="muted" sub="in window" />
            <MStat label="Peak ↑" value={fmtMbps(peakUp)} tone="muted" sub="in window" />
          </MStatGrid>

          <MSection title="Shape over the window">
            <MCard>
              {/* Presentational only — every value is also in the stats above
                  and in each bar's own title, so the picture is never the sole
                  carrier of the information. */}
              <div className="flex h-24 items-end gap-px" aria-hidden="true">
                {series.map(p => (
                  <div key={p.ts} className="flex min-w-0 flex-1 flex-col justify-end gap-px"
                    title={`${new Date(p.ts).toLocaleTimeString()} — ↓ ${fmtMbps(p.down)} ↑ ${fmtMbps(p.up)}`}>
                    <div className="w-full rounded-t-sm bg-nms-accent"
                      style={{ height: `${Math.max(1, (p.down / scale) * 70)}%` }} />
                    <div className="w-full rounded-b-sm bg-nms-accent/40"
                      style={{ height: `${Math.max(1, (p.up / scale) * 30)}%` }} />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-[10px] text-nms-text-dim">
                <span className="flex items-center gap-1">
                  <ArrowDown className="h-3 w-3" aria-hidden="true" />downlink
                  <span className="ml-2 flex items-center gap-1">
                    <ArrowUp className="h-3 w-3" aria-hidden="true" />uplink
                  </span>
                </span>
                <span className="tabular-nums">{series.length} samples</span>
              </div>
            </MCard>
          </MSection>
        </>
      )}

      <p className="text-[11px] text-nms-text-dim">
        Per-subscriber and per-radio breakdowns, and the zoomable chart, are on the
        desktop Traffic History page.
      </p>
    </MScreen>
  );
}
