import { useEffect, useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { ScrollText, Pause, Play, Trash2, ArrowDownToLine } from 'lucide-react';
import axios from 'axios';
import { useLogStream, type LogEntry } from '../hooks/useLogStream';
import { MScreen, MChips, MEmpty, MSearch } from './MobileKit';

/**
 * Unified Logs, built for a phone.
 *
 * The desktop page is a 12-service checkbox matrix, a verbosity control, a
 * download modal, a syslog-forwarding modal and a Major Events view, around a
 * wide monospace pane. None of that fits, and most of it is configuration
 * rather than reading.
 *
 * What survives is the part a phone is for: watch what the core is saying right
 * now, narrow it, and stop it moving so you can read one line. Two details
 * matter at this width:
 *
 *  - Lines WRAP rather than scrolling horizontally. A log line here routinely
 *    runs past 200 characters, and a horizontally-scrolling pane on a phone
 *    means swiping right to read every single line, then back again.
 *  - Follow is a toggle you can switch off. Autoscroll is correct while
 *    watching and actively hostile while reading, because each new line yanks
 *    the viewport away mid-sentence.
 */

type Source = 'open5gs' | 'ims' | 'gsm' | 'frr' | 'docker';

const SOURCES: ReadonlyArray<{ value: Source; label: string }> = [
  { value: 'open5gs', label: 'Core' },
  { value: 'ims', label: 'IMS' },
  { value: 'gsm', label: '2G' },
  { value: 'frr', label: 'Routing' },
  { value: 'docker', label: 'NMS' },
];

/**
 * Every service for a source, because the mobile page has no per-service
 * checkbox matrix and an empty list is NOT "everything".
 *
 * `useLogStream` sends `unsubscribe_logs` when `services` is empty, so passing
 * `[]` here would produce a view that connects, reports "Streaming", and shows
 * nothing forever — a working-looking empty page, which is the worst failure
 * shape. These lists mirror LogsPage's own constants; `docker` is the one
 * source whose services are discovered at runtime, so it is fetched.
 */
const SOURCE_SERVICES: Record<Exclude<Source, 'docker'>, readonly string[]> = {
  open5gs: ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'],
  ims: ['kamailio-pcscf', 'kamailio-icscf', 'kamailio-scscf', 'kamailio-smsc',
    'pyhss-api', 'pyhss-diameter', 'pyhss-hss', 'mariadb', 'rtpengine-daemon'],
  gsm: ['osmo-stp', 'osmo-hlr', 'osmo-msc', 'osmo-mgw', 'osmo-bsc', 'osmo-bts-virtual',
    'osmo-pcu', 'osmo-sgsn', 'osmo-ggsn'],
  frr: ['frr'],
};

/** Classifies a line for colour. Severity is not a field — it is in the text. */
function toneOf(line: string): string {
  const l = line.toLowerCase();
  if (/\b(error|fatal|fail|failed|crit|assert|abort)\b/.test(l)) return 'text-nms-red';
  if (/\b(warn|warning|retry|timeout|unreachable)\b/.test(l)) return 'text-nms-amber';
  return 'text-nms-text-dim';
}

export function MobileLogsPage(): JSX.Element {
  const [source, setSource] = useState<Source>('open5gs');
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState('');

  const [dockerContainers, setDockerContainers] = useState<string[]>([]);
  useEffect(() => {
    if (source !== 'docker') return;
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    axios.get(`${API_URL}/docker/containers`)
      .then(r => setDockerContainers(r.data.containers || []))
      .catch(() => setDockerContainers([]));
  }, [source]);

  // Stable identity: a new array each render would re-fire the hook's
  // subscribe effect every time, which re-requests the recent snapshot.
  const services = useMemo(
    () => (source === 'docker' ? dockerContainers : [...SOURCE_SERVICES[source]]),
    [source, dockerContainers],
  );

  // 400 rather than the desktop's larger buffer: every line here is a wrapped
  // multi-line block, so the DOM cost per entry is several times higher, and a
  // phone is the device least able to absorb it.
  const { logs, connected, clearLogs, logContainerRef } = useLogStream({
    source,
    services,
    maxLines: 400,
    autoScroll: follow,
    paused,
  });

  const shown = useMemo((): LogEntry[] => {
    const needle = q.trim().toLowerCase();
    if (!needle) return logs;
    return logs.filter(l =>
      l.message.toLowerCase().includes(needle) || l.service.toLowerCase().includes(needle));
  }, [logs, q]);

  return (
    <MScreen title="Unified Logs">
      <MChips ariaLabel="Log source" value={source} onChange={setSource} options={SOURCES} />

      <MSearch value={q} onChange={setQ} label="Filter log lines" placeholder="Filter lines…" />

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setPaused(p => !p)}
          aria-pressed={paused}
          className={clsx(
            'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition-colors',
            paused
              ? 'border-nms-amber/40 bg-nms-amber/10 text-nms-amber'
              : 'border-nms-border-strong bg-nms-surface text-nms-text-dim active:bg-nms-surface-2',
          )}
        >
          {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          onClick={() => setFollow(f => !f)}
          aria-pressed={follow}
          className={clsx(
            'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border text-xs font-semibold transition-colors',
            follow
              ? 'border-nms-accent bg-nms-accent text-nms-accent-fg'
              : 'border-nms-border-strong bg-nms-surface text-nms-text-dim active:bg-nms-surface-2',
          )}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />
          Follow
        </button>
        <button
          type="button"
          onClick={clearLogs}
          aria-label="Clear log view"
          className="flex min-h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-nms-border-strong bg-nms-surface text-nms-text-dim active:bg-nms-surface-2"
        >
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 text-[11px] text-nms-text-dim">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={clsx('h-2 w-2 rounded-full', connected ? 'bg-nms-green' : 'bg-nms-red')} />
          {connected ? 'Streaming' : 'Disconnected'}
          {paused && ' · paused'}
        </span>
        <span className="tabular-nums">{shown.length} line{shown.length === 1 ? '' : 's'}</span>
      </div>

      {/* The stream. Wrapped, not horizontally scrollable — see the header. */}
      <div
        ref={logContainerRef}
        className="h-[60vh] overflow-y-auto overscroll-contain rounded-xl border border-nms-border bg-nms-bg p-2"
      >
        {shown.length === 0 ? (
          <MEmpty icon={ScrollText} title={q ? 'Nothing matches' : 'Waiting for lines'}
            hint={q
              ? `No line contains “${q}”.`
              : services.length === 0
                ? 'No services to subscribe to for this source.'
                : 'Nothing has been logged since this view opened.'} />
        ) : (
          <ol className="space-y-1.5">
            {shown.map((l, i) => (
              <li key={`${l.timestamp}-${i}`} className="border-b border-nms-border/50 pb-1.5 last:border-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="shrink-0 font-mono text-[10px] text-nms-text-dim">
                    {l.timestamp.slice(11, 19) || l.timestamp}
                  </span>
                  <span className="truncate font-mono text-[10px] font-semibold text-nms-accent">
                    {l.service}
                  </span>
                </div>
                <p className={clsx('mt-0.5 break-words font-mono text-[11px] leading-snug', toneOf(l.message))}>
                  {l.message}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <p className="text-[11px] text-nms-text-dim">
        Downloading logs, syslog forwarding, per-service selection and the Major Events
        view are on the desktop Logs page.
      </p>
    </MScreen>
  );
}
