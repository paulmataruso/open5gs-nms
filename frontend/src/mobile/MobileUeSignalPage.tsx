import { useCallback, useEffect, useState } from 'react';
import { Wifi, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { radioSignalApi, type SignalUe, type SignalRadio } from '../api/radioSignal';
import {
  MScreen, MSection, MStatGrid, MStat, MRows, MRow, MBadge, MSheet, MFacts,
  MEmpty, MLoading, MSearch, fmtAgo,
} from './MobileKit';

/**
 * 4G/5G UE Signal, built for a phone.
 *
 * This is the view most worth having on a phone of any in the app, because it
 * is what you read while physically standing next to the thing you are
 * testing. So the per-UE radio quality is the whole page, and the radio
 * credential management (AES-encrypted, admin-only) is left on the desktop.
 *
 * RSRP thresholds are the ones operators actually use for LTE/NR coverage
 * bands, not arbitrary thirds: ≥ -80 good, ≥ -95 fair, ≥ -110 poor, below that
 * effectively unusable. They carry a word as well as a colour, so the state is
 * never conveyed by hue alone.
 */

function rsrpTone(rsrp: number | null | undefined): 'ok' | 'warn' | 'bad' | 'muted' {
  if (rsrp === null || rsrp === undefined) return 'muted';
  // -80 and -95 share the 'ok' tone and differ only in wording, so one
  // branch covers both here; rsrpWord() is where they separate.
  if (rsrp >= -95) return 'ok';
  if (rsrp >= -110) return 'warn';
  return 'bad';
}

function rsrpWord(rsrp: number | null | undefined): string {
  if (rsrp === null || rsrp === undefined) return 'no reading';
  if (rsrp >= -80) return 'excellent';
  if (rsrp >= -95) return 'good';
  if (rsrp >= -110) return 'poor';
  return 'unusable';
}

const dbm = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${Math.round(v)} dBm`;
const db = (v: number | null | undefined): string =>
  v === null || v === undefined ? '—' : `${Math.round(v)} dB`;

export function MobileUeSignalPage(): JSX.Element {
  const [ues, setUes] = useState<SignalUe[]>([]);
  const [radios, setRadios] = useState<SignalRadio[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [sheet, setSheet] = useState<SignalUe | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await radioSignalApi.overview('', 1);
      setUes(r.ues);
      setRadios(r.radios);
    } catch {
      setUes([]);
      setRadios([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const pollNow = useCallback(() => {
    setPolling(true);
    void (async () => {
      try {
        const r = await radioSignalApi.poll();
        const ok = r.results.filter(x => x.success).length;
        const failed = r.results.filter(x => !x.success);
        if (failed.length === 0) {
          toast.success(`Polled ${ok} radio${ok === 1 ? '' : 's'}`);
        } else {
          // Naming which radio failed matters here — "some failed" sends you
          // to a desktop to find out which.
          toast.error(`${ok} ok, ${failed.length} failed: ${failed.map(f => f.radioId).join(', ')}`,
            { duration: 8000 });
        }
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Poll failed');
      } finally {
        setPolling(false);
      }
    })();
  }, [load]);

  const needle = q.trim().toLowerCase();
  const shown = ues.filter(u => !needle
    || u.imsi?.toLowerCase().includes(needle)
    || u.nickname?.toLowerCase().includes(needle)
    || u.msisdn?.toLowerCase().includes(needle)
    || u.radioName.toLowerCase().includes(needle));

  if (loading) {
    return <MScreen title="UE Signal"><MLoading label="Reading radio metrics" /></MScreen>;
  }

  const withReading = ues.filter(u => u.rsrp !== null && u.rsrp !== undefined);
  const avgRsrp = withReading.length > 0
    ? withReading.reduce((s, u) => s + (u.rsrp ?? 0), 0) / withReading.length
    : null;

  return (
    <MScreen title="UE Signal">
      <MStatGrid>
        <MStat label="UEs reporting" value={ues.length} tone="accent"
          sub={`${radios.length} radio${radios.length === 1 ? '' : 's'}`} />
        <MStat label="Average RSRP" value={dbm(avgRsrp)} tone={rsrpTone(avgRsrp)}
          sub={rsrpWord(avgRsrp)} />
      </MStatGrid>

      <MSearch value={q} onChange={setQ} label="Search UEs" placeholder="IMSI, nickname or radio…" />

      <button
        type="button"
        onClick={pollNow}
        disabled={polling}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-nms-accent/40 bg-nms-surface text-xs font-semibold text-nms-accent active:bg-nms-surface-2 disabled:opacity-50"
      >
        <RefreshCw className={polling ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} aria-hidden="true" />
        {polling ? 'Polling radios…' : 'Poll radios now'}
      </button>

      <MSection title={`${shown.length} UE${shown.length === 1 ? '' : 's'}`}>
        {shown.length === 0 ? (
          <MEmpty icon={Wifi} title={needle ? 'Nothing matches' : 'No UEs reporting'}
            hint={needle ? undefined : 'No radio has returned a per-UE sample in the last hour.'} />
        ) : (
          <MRows>
            {shown.map(u => (
              <MRow
                key={`${u.radioId}-${u.ueId}`}
                tone={rsrpTone(u.rsrp)}
                title={u.nickname || u.imsi || u.ueId}
                subtitle={`${u.radioName} · ${fmtAgo(u.sampledAt)} ago`}
                meta={
                  <>
                    <MBadge tone={rsrpTone(u.rsrp)}>{dbm(u.rsrp)} {rsrpWord(u.rsrp)}</MBadge>
                    {u.sinr !== null && u.sinr !== undefined && <MBadge tone="muted">SINR {db(u.sinr)}</MBadge>}
                  </>
                }
                onPress={() => setSheet(u)}
                ariaLabel={`${u.nickname || u.imsi || u.ueId}, RSRP ${dbm(u.rsrp)}, ${rsrpWord(u.rsrp)}`}
              />
            ))}
          </MRows>
        )}
      </MSection>

      <MSheet
        open={sheet !== null}
        title={sheet?.nickname || sheet?.imsi || sheet?.ueId || 'UE'}
        subtitle={sheet ? `${sheet.radioName} · ${sheet.vendor}` : undefined}
        onClose={() => setSheet(null)}
      >
        {sheet && (
          <MFacts rows={[
            { label: 'IMSI', value: sheet.imsi ?? '—', mono: true },
            { label: 'MSISDN', value: sheet.msisdn ?? '—', mono: true },
            { label: 'ICCID', value: sheet.iccid ?? '—', mono: true },
            { label: 'Radio', value: sheet.radioName },
            { label: 'RSRP', value: `${dbm(sheet.rsrp)} (${rsrpWord(sheet.rsrp)})` },
            { label: 'RSRQ', value: db(sheet.rsrq) },
            { label: 'RSSI', value: dbm(sheet.rssi) },
            { label: 'SINR', value: db(sheet.sinr) },
            { label: 'SNR', value: db(sheet.snr) },
            { label: 'MCS ↓/↑', value: `${sheet.dlMcs ?? '—'} / ${sheet.ulMcs ?? '—'}` },
            { label: 'CQI', value: sheet.primaryDlCqi ?? '—' },
            { label: 'BLER', value: sheet.bler === null || sheet.bler === undefined ? '—' : `${sheet.bler}%` },
            { label: 'Throughput ↓/↑', value: `${sheet.dlMbps ?? '—'} / ${sheet.ulMbps ?? '—'} Mbps` },
            { label: 'Tx power', value: dbm(sheet.txPower) },
            { label: 'Path loss', value: db(sheet.pathLoss) },
            { label: 'Sampled', value: `${fmtAgo(sheet.sampledAt)} ago` },
          ]} />
        )}
      </MSheet>
    </MScreen>
  );
}
