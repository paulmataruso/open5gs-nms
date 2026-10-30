import { useCallback, useEffect, useState } from 'react';
import { Shield, RefreshCw } from 'lucide-react';
import { useServiceStore, useTopologyStore } from '../stores';
import { subscriberApi } from '../api';
import { sasApi, type SasStatus } from '../api/sas';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MEmpty, MLoading,
} from './MobileKit';

/**
 * Dashboard, built for a phone.
 *
 * The desktop dashboard is a wide stats grid plus a dozen module cards plus
 * the RAN kill-switch header row — about four screenfuls on a phone, with the
 * header buttons overflowing off the right edge. This answers the one question
 * a phone is actually used for: is anything wrong right now, and if so what.
 *
 * It is deliberately READ-ONLY. The desktop header carries Block RAN and the
 * four per-generation kill switches; those drop every radio of a generation at
 * once, and a destructive bulk action sitting one thumb-tap from a monitoring
 * screen invites exactly the mistake you least want made one-handed. Blocking
 * is still reachable per-radio from the RAN page, where it is behind a row tap
 * and a sheet.
 */
export function MobileDashboardPage(
  { onNavigate }: { onNavigate: (tab: string) => void },
): JSX.Element {
  const statuses = useServiceStore(s => s.statuses);
  const fetchStatuses = useServiceStore(s => s.fetchStatuses);
  const interfaceStatus = useTopologyStore(s => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore(s => s.fetchInterfaceStatus);

  const [subTotal, setSubTotal] = useState<number | null>(null);
  const [sas, setSas] = useState<SasStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const tasks: Promise<unknown>[] = [
      fetchStatuses(),
      fetchInterfaceStatus(),
      // limit 1 — this is only for the total, so there is no reason to pull a
      // page of 50 subscriber records onto a phone to count them.
      subscriberApi.list(0, 1).then(r => setSubTotal(r.total)).catch(() => setSubTotal(null)),
    ];
    // SAS is an unconditional destination in NAV_ITEMS (SASBench always owns
    // the protocol ports), so there is no feature flag to check — only
    // whether it answers.
    tasks.push(sasApi.getStatus().then(setSas).catch(() => setSas(null)));
    await Promise.allSettled(tasks);
    setRefreshing(false);
    setLoaded(true);
  }, [fetchStatuses, fetchInterfaceStatus]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!loaded) {
    return <MScreen title="Dashboard"><MLoading label="Checking the core" /></MScreen>;
  }

  const down = statuses.filter(s => !s.active);
  const up = statuses.length - down.length;
  const ues = (interfaceStatus?.activeUEs4G.length ?? 0) + (interfaceStatus?.activeUEs5G.length ?? 0);
  const radios = (interfaceStatus?.s1mme.connectedEnodebs.length ?? 0)
    + (interfaceStatus?.n2.connectedGnodebs.length ?? 0);

  return (
    <MScreen title="Dashboard">
      <MStatGrid>
        <MStat
          label="Core NFs"
          value={statuses.length === 0 ? '—' : `${up}/${statuses.length}`}
          tone={down.length === 0 ? 'ok' : 'bad'}
          sub={down.length === 0 ? 'all running' : `${down.length} down`}
          onPress={() => onNavigate('services')}
        />
        <MStat
          label="UEs attached"
          value={ues}
          tone="accent"
          sub={`${interfaceStatus?.activeUEs4G.length ?? 0} 4G · ${interfaceStatus?.activeUEs5G.length ?? 0} 5G`}
          onPress={() => onNavigate('ran')}
        />
        <MStat
          label="Radios"
          value={radios}
          tone={radios === 0 ? 'warn' : 'ok'}
          sub={radios === 0 ? 'none connected' : 'associations up'}
          onPress={() => onNavigate('ran')}
        />
        <MStat
          label="Subscribers"
          value={subTotal ?? '—'}
          tone="muted"
          sub="provisioned"
          onPress={() => onNavigate('subscribers')}
        />
      </MStatGrid>

      {/* The one thing worth interrupting a glance for. Shown only when real. */}
      {down.length > 0 && (
        <MSection title={`Not running (${down.length})`}>
          <MRows>
            {down.map(s => (
              <MRow
                key={s.name}
                tone="bad"
                title={s.name}
                subtitle={`${s.state}${s.subState ? ` / ${s.subState}` : ''}`}
                meta={s.restartCount > 0 ? <MBadge tone="warn">{s.restartCount} restarts</MBadge> : undefined}
                onPress={() => onNavigate('services')}
                ariaLabel={`${s.name} is not running`}
              />
            ))}
          </MRows>
        </MSection>
      )}

      <MSection title="CBRS SAS">
          {!sas ? (
            <MEmpty icon={Shield} title="SAS unreachable" hint="SASBench did not answer." />
          ) : !sas.reachable ? (
            <MEmpty icon={Shield} title="SAS unreachable" hint={sas.error ?? 'SASBench did not answer.'} />
          ) : (
            <MStatGrid>
              <MStat
                label="CBSDs"
                value={`${sas.counts?.cbsdsRegistered ?? 0}/${sas.counts?.cbsdsTotal ?? 0}`}
                tone={(sas.counts?.cbsdsPending ?? 0) > 0 ? 'warn' : 'ok'}
                sub="registered"
                onPress={() => onNavigate('sas')}
              />
              <MStat
                label="Band in use"
                value={sas.derived ? `${Math.round(sas.derived.occupancy.distinctMHz)} MHz` : '—'}
                tone="accent"
                sub={sas.derived ? `${sas.derived.radiosWithGrant} with a grant` : undefined}
                onPress={() => onNavigate('sas')}
              />
            </MStatGrid>
          )}
      </MSection>

      <MSection title="Go to">
        <MRows>
          <MRow title="RAN Network" subtitle="Radios and attached UEs" onPress={() => onNavigate('ran')} />
          <MRow title="Unified Logs" subtitle="What the core is actually saying" onPress={() => onNavigate('logs')} />
          <MRow title="Services" subtitle="Start, stop and restart NFs" onPress={() => onNavigate('services')} />
        </MRows>
      </MSection>

      <button
        type="button"
        onClick={() => void refresh()}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-nms-border-strong bg-nms-surface text-xs font-medium text-nms-text-dim active:bg-nms-surface-2"
      >
        <RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" />
        {refreshing ? 'Refreshing…' : 'Refresh now'}
      </button>
      <p className="text-center text-[11px] text-nms-text-dim">Auto-refreshes every 20s.</p>
    </MScreen>
  );
}
