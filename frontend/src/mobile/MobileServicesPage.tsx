import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Square, RotateCw, Server, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useServiceStore } from '../stores';
import { serviceApi } from '../api';
import { useAuth } from '../contexts/AuthContext';
import type { ServiceStatus } from '../types';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MChips, MSheet, MAction,
  MFacts, MEmpty, MIconButton, MLoading, MSearch, fmtBytes,
} from './MobileKit';

/**
 * Services, built for a phone.
 *
 * The desktop page is a table with a start/stop/restart button cluster per
 * row. Three 20px chips in one table cell is the same overlap problem the RAN
 * page had, so the per-service actions move into a sheet where each is a
 * full-width 48px target — and, more importantly, where "Stop" is not
 * adjacent to "Restart" on a surface being operated with a thumb.
 *
 * There is no bulk start/stop/restart here on purpose, even though the desktop
 * has one: stopping all 17 NFs drops the whole network, and that is not a
 * one-tap-from-a-list action. Per-service is always available.
 */

type Filter = 'all' | 'down' | 'running';

export function MobileServicesPage(): JSX.Element {
  const statuses = useServiceStore(s => s.statuses);
  const fetchStatuses = useServiceStore(s => s.fetchStatuses);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [sheet, setSheet] = useState<ServiceStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await fetchStatuses();
    setRefreshing(false);
    setLoaded(true);
  }, [fetchStatuses]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void fetchStatuses(); }, 15_000);
    return () => clearInterval(id);
  }, [refresh, fetchStatuses]);

  const down = statuses.filter(s => !s.active);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return statuses.filter(s => {
      if (filter === 'down' && s.active) return false;
      if (filter === 'running' && !s.active) return false;
      if (needle && !s.name.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [statuses, filter, q]);

  const act = useCallback((
    svc: ServiceStatus, action: 'start' | 'stop' | 'restart',
  ) => {
    setBusy(action);
    void (async () => {
      try {
        const r = await serviceApi.action(svc.name, action);
        // The API reporting success is not the same as the unit actually being
        // up — re-read the real status before saying anything definitive.
        await fetchStatuses();
        const now = useServiceStore.getState().statuses.find(s => s.name === svc.name);
        if (action === 'stop') {
          toast.success(now && !now.active ? `${svc.name} stopped` : `${svc.name}: ${r.message}`);
        } else if (now?.active) {
          toast.success(`${svc.name} is running`);
        } else {
          toast.error(`${svc.name} did not come up — it is ${now?.state ?? 'unknown'}`, { duration: 8000 });
        }
        setSheet(null);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Failed to ${action} ${svc.name}`);
      } finally {
        setBusy(null);
      }
    })();
  }, [fetchStatuses]);

  if (!loaded) {
    return <MScreen title="Services"><MLoading label="Reading unit status" /></MScreen>;
  }

  return (
    <MScreen title="Services">
      <MStatGrid>
        <MStat label="Running" value={statuses.length - down.length} tone="ok" sub={`of ${statuses.length}`} />
        <MStat label="Not running" value={down.length} tone={down.length ? 'bad' : 'muted'}
          sub={down.length ? 'needs attention' : 'nothing down'} />
      </MStatGrid>

      <MSearch value={q} onChange={setQ} label="Search services" placeholder="Search services…" />

      <MChips
        ariaLabel="Filter services"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All', count: statuses.length },
          { value: 'down', label: 'Down', count: down.length },
          { value: 'running', label: 'Running', count: statuses.length - down.length },
        ]}
      />

      <MSection
        title={`${shown.length} service${shown.length === 1 ? '' : 's'}`}
        right={
          <MIconButton label="Refresh service status" icon={RefreshCw} spinning={refreshing}
            onPress={() => void refresh()} />
        }
      >
        {shown.length === 0 ? (
          <MEmpty icon={Server} title="Nothing matches" hint="Try a different filter or search." />
        ) : (
          <MRows>
            {shown.map(s => (
              <MRow
                key={s.name}
                tone={s.active ? 'ok' : 'bad'}
                title={s.name}
                subtitle={s.active
                  ? `up ${s.uptime ?? '—'}`
                  : `${s.state}${s.subState ? ` / ${s.subState}` : ''}`}
                meta={
                  <>
                    {!s.enabled && <MBadge tone="warn">disabled at boot</MBadge>}
                    {s.restartCount > 0 && <MBadge tone="warn">{s.restartCount} restarts</MBadge>}
                    {s.source && s.source !== 'systemd' && <MBadge tone="muted">{s.source}</MBadge>}
                  </>
                }
                onPress={() => setSheet(s)}
                ariaLabel={`${s.name}, ${s.active ? 'running' : 'not running'}`}
              />
            ))}
          </MRows>
        )}
      </MSection>

      <MSheet
        open={sheet !== null}
        title={sheet?.name ?? 'Service'}
        subtitle={sheet?.unitName}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <>
            <MFacts rows={[
              { label: 'Unit', value: sheet.unitName, mono: true },
              { label: 'State', value: `${sheet.state}${sheet.subState ? ` / ${sheet.subState}` : ''}` },
              { label: 'At boot', value: sheet.enabled ? 'enabled' : 'disabled' },
              { label: 'Uptime', value: sheet.uptime ?? '—' },
              { label: 'PID', value: sheet.pid ?? '—', mono: true },
              { label: 'Restarts', value: sheet.restartCount },
              { label: 'CPU', value: sheet.cpuPercent === null ? '—' : `${sheet.cpuPercent.toFixed(1)}%` },
              { label: 'Memory', value: fmtBytes(sheet.memoryBytes) },
            ]} />

            {!isAdmin ? (
              <p className="text-xs text-nms-text-dim">
                View-only mode — starting and stopping services needs an admin account.
              </p>
            ) : (
              <>
                {sheet.active ? (
                  <>
                    <MAction label="Restart" icon={RotateCw} tone="warn"
                      hint="Brief interruption while the unit comes back."
                      busy={busy === 'restart'} onPress={() => act(sheet, 'restart')} />
                    <MAction label="Stop" icon={Square} tone="bad"
                      hint="Stays down until started again. Dependent functions will fail meanwhile."
                      busy={busy === 'stop'} onPress={() => act(sheet, 'stop')} />
                  </>
                ) : (
                  <MAction label="Start" icon={Play} tone="ok"
                    hint="Brings the unit up now."
                    busy={busy === 'start'} onPress={() => act(sheet, 'start')} />
                )}
              </>
            )}
          </>
        )}
      </MSheet>
    </MScreen>
  );
}
