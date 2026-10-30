import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Radio, Users, RotateCcw, UserX, UserCheck, ShieldAlert, ShieldOff, RefreshCw, Wifi,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTopologyStore, type ActiveUE } from '../stores';
import { radioBlockApi, gnbBlockApi, radioTagsApi } from '../api';
import { blockUe, unblockUe, getBlockedUes, deregisterUe, type UeBlockInfo } from '../api/ueBlock';
import { useAuth } from '../contexts/AuthContext';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MChips, MSheet, MAction,
  MFacts, MEmpty, MIconButton, MLoading, fmtMbps,
} from './MobileKit';

/**
 * RAN Network, built for a phone.
 *
 * The desktop page is three wide tables (4G radios, 5G radios, all UE
 * sessions) whose rightmost column holds the per-row actions. At 375px that
 * column is off-screen behind a horizontal scroll, and the two action chips in
 * it — 20px tall, sitting side by side — overlap. Both problems are the table,
 * not the styling, so this page does not use one.
 *
 * Instead: one row per radio or UE, owning its full width, carrying the fields
 * that were columns as a subtitle; and pressing a row opens a sheet where each
 * action is a full-width 48px target with a sentence of consequence next to
 * it. That is also strictly safer — Block and Detach are one tap apart on the
 * desktop, and they do very different things.
 */

type Gen = '4G' | '5G';
type Filter = 'all' | '4G' | '5G';

interface MobileUe extends ActiveUE {
  gen: Gen;
}

interface RadioEntry {
  ip: string;
  gen: Gen;
  ues: number;
  setupSuccess: boolean;
  plmn?: string;
}

export function MobileRanPage(): JSX.Element {
  const interfaceStatus = useTopologyStore(s => s.interfaceStatus);
  const fetchInterfaceStatus = useTopologyStore(s => s.fetchInterfaceStatus);
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [filter, setFilter] = useState<Filter>('all');
  const [tags, setTags] = useState<Record<string, string>>({});
  const [blocked4G, setBlocked4G] = useState<Set<string>>(new Set());
  const [blocked5G, setBlocked5G] = useState<Set<string>>(new Set());
  const [blockedUes, setBlockedUes] = useState<UeBlockInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [sheetUe, setSheetUe] = useState<MobileUe | null>(null);
  const [sheetRadio, setSheetRadio] = useState<RadioEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [t, b4, b5, bu] = await Promise.allSettled([
      radioTagsApi.getAll(),
      radioBlockApi.getAll(),
      gnbBlockApi.getAll(),
      getBlockedUes(),
    ]);
    if (t.status === 'fulfilled') setTags(t.value);
    if (b4.status === 'fulfilled') setBlocked4G(new Set(b4.value.map(r => r.ip)));
    if (b5.status === 'fulfilled') setBlocked5G(new Set(b5.value.map(r => r.ip)));
    if (bu.status === 'fulfilled') setBlockedUes(bu.value);
    await fetchInterfaceStatus();
    setRefreshing(false);
  }, [fetchInterfaceStatus]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void fetchInterfaceStatus(); }, 10_000);
    return () => clearInterval(id);
  }, [refresh, fetchInterfaceStatus]);

  const blockedUeImsis = useMemo(() => new Set(blockedUes.map(b => b.imsi)), [blockedUes]);

  const radios = useMemo((): RadioEntry[] => {
    if (!interfaceStatus) return [];
    const four = interfaceStatus.s1mme.connectedEnodebs.map((r): RadioEntry => ({
      ip: r.ip, gen: '4G', ues: r.numConnectedUes, setupSuccess: r.setupSuccess, plmn: r.plmn,
    }));
    const five = interfaceStatus.n2.connectedGnodebs.map((r): RadioEntry => ({
      ip: r.ip, gen: '5G', ues: r.numConnectedUes, setupSuccess: r.setupSuccess, plmn: r.plmn,
    }));
    return [...four, ...five];
  }, [interfaceStatus]);

  const ues = useMemo((): MobileUe[] => {
    if (!interfaceStatus) return [];
    return [
      ...interfaceStatus.activeUEs4G.map((u): MobileUe => ({ ...u, gen: '4G' })),
      ...interfaceStatus.activeUEs5G.map((u): MobileUe => ({ ...u, gen: '5G' })),
    ];
  }, [interfaceStatus]);

  const shownRadios = radios.filter(r => filter === 'all' || r.gen === filter);
  const shownUes = ues.filter(u => filter === 'all' || u.gen === filter);

  const isRadioBlocked = (r: RadioEntry): boolean =>
    r.gen === '4G' ? blocked4G.has(r.ip) : blocked5G.has(r.ip);

  /* ── Actions ──────────────────────────────────────────────────────────── */

  const runUeAction = useCallback(async (
    key: string, imsi: string, fn: () => Promise<void>,
  ) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Action failed for ${imsi}`);
    } finally {
      setBusy(null);
      await refresh();
    }
  }, [refresh]);

  const onDetach = useCallback((ue: MobileUe) => {
    void runUeAction('detach', ue.imsi, async () => {
      const r = await deregisterUe(ue.imsi);
      // Each of these is a real, reportable outcome rather than a failure, so
      // each gets its own wording. Reporting a detach for a UE that was never
      // actually notified is the specific thing this avoids.
      if (r.status === 'detached-sent' && r.reattachRequested) {
        toast.success(`${ue.imsi} detached — it should re-attach shortly`);
      } else if (r.status === 'not-attached') {
        toast(`${ue.imsi} is not currently attached — nothing to detach`);
      } else {
        toast.error(r.message, { duration: 8000 });
      }
      setSheetUe(null);
    });
  }, [runUeAction]);

  const onBlockUe = useCallback((ue: MobileUe) => {
    void runUeAction('block', ue.imsi, async () => {
      const r = await blockUe(ue.imsi);
      if (r.detach?.attempted && r.detach.status !== 'detached-sent') {
        toast.error(`${ue.imsi} blocked, but the detach failed (${r.detach.status ?? 'no response'}) — it stays connected until it re-attaches`);
      } else {
        toast.success(`${ue.imsi} detached and blocked`);
      }
      setSheetUe(null);
    });
  }, [runUeAction]);

  const onUnblockUe = useCallback((ue: MobileUe) => {
    void runUeAction('unblock', ue.imsi, async () => {
      await unblockUe(ue.imsi);
      toast.success(`${ue.imsi} unblocked`);
      setSheetUe(null);
    });
  }, [runUeAction]);

  const onToggleRadio = useCallback((r: RadioEntry) => {
    const api = r.gen === '4G' ? radioBlockApi : gnbBlockApi;
    const wasBlocked = isRadioBlocked(r);
    void runUeAction('radio', r.ip, async () => {
      if (wasBlocked) {
        await api.unblock(r.ip);
        toast.success(`${r.ip} unblocked`);
      } else {
        await api.block(r.ip);
        toast.success(`${r.ip} blocked`);
      }
      setSheetRadio(null);
    });
  // isRadioBlocked reads state that `runUeAction`'s refresh updates; recreating
  // the callback on every block-set change is correct and cheap here.
  }, [runUeAction, blocked4G, blocked5G]);

  /* ── Render ───────────────────────────────────────────────────────────── */

  if (!interfaceStatus) {
    return <MScreen title="RAN Network"><MLoading label="Reading interface status" /></MScreen>;
  }

  const radiosUp = radios.filter(r => r.setupSuccess && !isRadioBlocked(r)).length;

  return (
    <MScreen title="RAN Network">
      <MStatGrid>
        <MStat label="Radios" value={`${radiosUp}/${radios.length}`} tone={radiosUp === radios.length ? 'ok' : 'warn'}
          sub={radios.length === 0 ? 'none connected' : `${radios.filter(r => r.gen === '4G').length} 4G · ${radios.filter(r => r.gen === '5G').length} 5G`} />
        <MStat label="UEs attached" value={ues.length} tone="accent"
          sub={`${ues.filter(u => u.gen === '4G').length} 4G · ${ues.filter(u => u.gen === '5G').length} 5G`} />
      </MStatGrid>

      <MChips
        ariaLabel="Filter by generation"
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: '4G', label: '4G', count: radios.filter(r => r.gen === '4G').length + ues.filter(u => u.gen === '4G').length },
          { value: '5G', label: '5G', count: radios.filter(r => r.gen === '5G').length + ues.filter(u => u.gen === '5G').length },
        ]}
      />

      <MSection
        title={`Radios (${shownRadios.length})`}
        right={
          <MIconButton label="Refresh RAN status" icon={RefreshCw} spinning={refreshing}
            onPress={() => void refresh()} />
        }
      >
        {shownRadios.length === 0 ? (
          <MEmpty icon={Radio} title="No radios connected" hint="Nothing has an S1-MME or N2 association up." />
        ) : (
          <MRows>
            {shownRadios.map(r => {
              const blocked = isRadioBlocked(r);
              return (
                <MRow
                  key={`${r.gen}-${r.ip}`}
                  tone={blocked ? 'bad' : r.setupSuccess ? 'ok' : 'warn'}
                  title={tags[r.ip] || r.ip}
                  subtitle={tags[r.ip] ? r.ip : (r.plmn ? `PLMN ${r.plmn}` : undefined)}
                  meta={
                    <>
                      <MBadge tone={r.gen === '5G' ? 'accent' : 'muted'}>{r.gen}</MBadge>
                      <MBadge tone="muted">{r.ues} UE{r.ues === 1 ? '' : 's'}</MBadge>
                      {blocked && <MBadge tone="bad">BLOCKED</MBadge>}
                      {!r.setupSuccess && !blocked && <MBadge tone="warn">setup failed</MBadge>}
                    </>
                  }
                  onPress={() => setSheetRadio(r)}
                  ariaLabel={`${tags[r.ip] || r.ip}, ${r.gen} radio, ${r.ues} UEs${blocked ? ', blocked' : ''}`}
                />
              );
            })}
          </MRows>
        )}
      </MSection>

      <MSection title={`Active UEs (${shownUes.length})`}>
        {shownUes.length === 0 ? (
          <MEmpty icon={Users} title="No UEs attached" hint="No subscriber has a live session right now." />
        ) : (
          <MRows>
            {shownUes.map((ue, i) => {
              const ueBlocked = blockedUeImsis.has(ue.imsi);
              return (
                <MRow
                  key={`${ue.imsi}-${i}`}
                  tone={ueBlocked ? 'bad' : ue.cmState === 'idle' ? 'warn' : 'ok'}
                  title={ue.metricsOnly ? 'metrics only' : (ue.nickname || ue.imsi)}
                  subtitle={ue.metricsOnly ? undefined : (ue.nickname ? ue.imsi : (ue.ip || undefined))}
                  meta={
                    <>
                      <MBadge tone={ue.gen === '5G' ? 'accent' : 'muted'}>{ue.gen}</MBadge>
                      {ue.cmState && <MBadge tone={ue.cmState === 'idle' ? 'warn' : 'ok'}>{ue.cmState}</MBadge>}
                      {(ue.dnn || ue.apn) && <MBadge tone="muted">{ue.dnn || ue.apn}</MBadge>}
                      {ueBlocked && <MBadge tone="bad">BLOCKED</MBadge>}
                    </>
                  }
                  onPress={ue.metricsOnly ? undefined : () => setSheetUe(ue)}
                  ariaLabel={`${ue.imsi}, ${ue.gen}${ueBlocked ? ', blocked' : ''}`}
                />
              );
            })}
          </MRows>
        )}
      </MSection>

      {/* ── UE action sheet ──────────────────────────────────────────────── */}
      <MSheet
        open={sheetUe !== null}
        title={sheetUe?.nickname || sheetUe?.imsi || 'UE'}
        subtitle={sheetUe?.nickname ? sheetUe.imsi : `${sheetUe?.gen ?? ''} · ${sheetUe?.ip ?? 'no IP'}`}
        onClose={() => setSheetUe(null)}
      >
        {sheetUe && (
          <>
            <MFacts rows={[
              { label: 'IMSI', value: sheetUe.imsi, mono: true },
              { label: 'UE IP', value: sheetUe.ip || '—', mono: true },
              { label: 'Generation', value: sheetUe.gen },
              { label: 'CM state', value: sheetUe.cmState ?? '—' },
              { label: 'DNN / APN', value: sheetUe.dnn || sheetUe.apn || '—' },
              { label: 'Radio', value: sheetUe.radioIp ? (tags[sheetUe.radioIp] || sheetUe.radioIp) : '—', mono: !tags[sheetUe.radioIp ?? ''] },
              {
                label: 'AMBR ↓/↑',
                value: sheetUe.ambrDownlink || sheetUe.ambrUplink
                  ? `${fmtMbps(sheetUe.ambrDownlink)} / ${fmtMbps(sheetUe.ambrUplink)}`
                  : '—',
              },
              {
                label: 'Security',
                value: sheetUe.securityEnc
                  ? `${sheetUe.securityEnc.toUpperCase()}${sheetUe.securityInt ? ` / ${sheetUe.securityInt.toUpperCase()}` : ''}`
                  : '—',
                mono: true,
              },
            ]} />

            {!isAdmin ? (
              <p className="text-xs text-nms-text-dim">
                View-only mode — detaching and blocking need an admin account.
              </p>
            ) : blockedUeImsis.has(sheetUe.imsi) ? (
              <MAction
                label="Unblock UE" icon={UserCheck} tone="muted"
                hint="Removes the nftables blackhole so it can attach again."
                busy={busy === 'unblock'}
                onPress={() => onUnblockUe(sheetUe)}
              />
            ) : (
              <>
                <MAction
                  label="Detach UE" icon={RotateCcw} tone="accent"
                  hint={sheetUe.gen === '5G'
                    ? 'Only supported on 4G — this will be refused rather than half-applied, and will say why.'
                    : sheetUe.cmState === 'idle'
                      ? 'Idle, so the MME pages it first. Its data session drops; it re-attaches by itself.'
                      : 'Forces it off and straight back — the network-side airplane-mode toggle. Its data session drops. Nothing persists.'}
                  busy={busy === 'detach'}
                  onPress={() => onDetach(sheetUe)}
                />
                <MAction
                  label="Block UE" icon={UserX} tone="bad"
                  hint="Detaches it AND blocks it from reconnecting until you unblock it."
                  busy={busy === 'block'}
                  onPress={() => onBlockUe(sheetUe)}
                />
              </>
            )}
          </>
        )}
      </MSheet>

      {/* ── Radio action sheet ───────────────────────────────────────────── */}
      <MSheet
        open={sheetRadio !== null}
        title={sheetRadio ? (tags[sheetRadio.ip] || sheetRadio.ip) : 'Radio'}
        subtitle={sheetRadio ? `${sheetRadio.gen} · ${sheetRadio.ip}` : undefined}
        onClose={() => setSheetRadio(null)}
      >
        {sheetRadio && (
          <>
            <MFacts rows={[
              { label: 'IP', value: sheetRadio.ip, mono: true },
              { label: 'Generation', value: sheetRadio.gen },
              { label: 'Connected UEs', value: sheetRadio.ues },
              { label: 'PLMN', value: sheetRadio.plmn ?? '—', mono: true },
              { label: 'Setup', value: sheetRadio.setupSuccess ? 'succeeded' : 'failed' },
              { label: 'State', value: isRadioBlocked(sheetRadio) ? 'Blocked' : 'Active' },
            ]} />
            {!isAdmin ? (
              <p className="text-xs text-nms-text-dim">
                View-only mode — blocking a radio needs an admin account.
              </p>
            ) : (
              <MAction
                label={isRadioBlocked(sheetRadio) ? 'Unblock radio' : 'Block radio'}
                icon={isRadioBlocked(sheetRadio) ? ShieldOff : ShieldAlert}
                tone={isRadioBlocked(sheetRadio) ? 'muted' : 'bad'}
                hint={isRadioBlocked(sheetRadio)
                  ? `Restores this ${sheetRadio.gen === '4G' ? 'eNB' : 'gNB'}'s paths to the core.`
                  : `Blocks ${sheetRadio.gen === '4G' ? 'S1-MME + S1-U' : 'N2 + N3'} on this host only (nftables). The radio itself is not touched, and every UE on it drops.`}
                busy={busy === 'radio'}
                onPress={() => onToggleRadio(sheetRadio)}
              />
            )}
          </>
        )}
      </MSheet>

      <p className="flex items-center gap-1.5 pt-1 text-[11px] text-nms-text-dim">
        <Wifi className="h-3 w-3 shrink-0" aria-hidden="true" />
        Live UE list refreshes every 10s.
      </p>
    </MScreen>
  );
}
