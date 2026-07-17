import { useState, useEffect, useMemo } from 'react';
import { RotateCw, Trash2, Radio, Wifi, WifiOff, LogIn, LogOut, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import axios from 'axios';
import { useLogStream, LogEntry, MajorEventType } from '../../hooks/useLogStream';
import { MultiSelectDropdown } from '../common/MultiSelectDropdown';
import { LogContextModal } from './LogContextModal';
import { radioTagsApi, subscriberApi } from '../../api';

const ALL_SERVICES = ['nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu'];

const EVENT_LABELS: Record<MajorEventType, string> = {
  radio_connect: 'Radio connected',
  radio_disconnect: 'Radio disconnected',
  ue_attach: 'UE attached',
  ue_detach: 'UE detached',
  ue_register: 'UE registered',
  ue_deregister: 'UE deregistered',
  pdu_session_up: 'PDU session up',
  pdu_session_down: 'PDU session down',
};

const EVENT_STYLES: Record<MajorEventType, { className: string; Icon: typeof Radio }> = {
  radio_connect:     { className: 'bg-green-500/10 text-green-400 border-green-500/30', Icon: Wifi },
  radio_disconnect:  { className: 'bg-red-500/10 text-red-400 border-red-500/30', Icon: WifiOff },
  ue_attach:         { className: 'bg-blue-500/10 text-blue-400 border-blue-500/30', Icon: LogIn },
  ue_register:       { className: 'bg-blue-500/10 text-blue-400 border-blue-500/30', Icon: LogIn },
  ue_detach:         { className: 'bg-slate-500/10 text-slate-400 border-slate-500/30', Icon: LogOut },
  ue_deregister:     { className: 'bg-slate-500/10 text-slate-400 border-slate-500/30', Icon: LogOut },
  pdu_session_up:    { className: 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30', Icon: ArrowUpCircle },
  pdu_session_down:  { className: 'bg-amber-500/10 text-amber-400 border-amber-500/30', Icon: ArrowDownCircle },
};

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('en-US', { hour12: false }) + '.' + date.getMilliseconds().toString().padStart(3, '0');
}

function EventBadge({ type }: { type: MajorEventType }) {
  const { className, Icon } = EVENT_STYLES[type];
  return (
    <span className={`flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold shrink-0 border whitespace-nowrap ${className}`}>
      <Icon className="w-3 h-3" /> {EVENT_LABELS[type]}
    </span>
  );
}

function renderEventLine(log: LogEntry, index: number, onSelect: (log: LogEntry) => void) {
  const event = log.event;
  return (
    <div
      key={index}
      onClick={() => onSelect(log)}
      title="Click to view this line in its raw log file"
      className="flex items-start gap-2 px-3 py-1.5 text-xs font-mono border-b border-nms-border/30 hover:bg-nms-surface-2/50 cursor-pointer"
    >
      <span className="text-nms-text-dim shrink-0 w-24">{formatTimestamp(log.timestamp)}</span>
      <span className="px-2 py-0.5 rounded text-xs font-semibold uppercase shrink-0 border bg-nms-surface-2 text-nms-text-dim border-nms-border">
        {log.service}
      </span>
      {event && <EventBadge type={event.type} />}
      <span className="text-nms-text break-all flex-1">
        {event?.imsi && <span className="text-nms-accent font-semibold">IMSI:{event.imsi} </span>}
        {event?.radioIp && <span className="text-purple-400 font-semibold">{event.radioIp} </span>}
        {event?.apn && <span className="text-nms-text-dim">APN:{event.apn} </span>}
        {log.message}
      </span>
    </div>
  );
}

const EVENT_TYPE_OPTIONS = (Object.keys(EVENT_LABELS) as MajorEventType[]).map(type => ({
  value: type,
  label: EVENT_LABELS[type],
}));

export function MajorEventsView() {
  const [selectedImsis, setSelectedImsis] = useState<string[]>([]);
  const [selectedRadioIps, setSelectedRadioIps] = useState<string[]>([]);
  const [selectedEventTypes, setSelectedEventTypes] = useState<string[]>([]);
  const [imsiOptions, setImsiOptions] = useState<{ value: string; label: string }[]>([]);
  const [radioOptions, setRadioOptions] = useState<{ value: string; label: string }[]>([]);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);

  useEffect(() => {
    subscriberApi.list(0, 5000).then(({ subscribers }) => {
      setImsiOptions(subscribers.map(s => ({
        value: s.imsi,
        label: s.nickname ? `${s.imsi} (${s.nickname})` : s.imsi,
      })));
    }).catch(() => {});

    // Radios actually seen (radio_connect/disconnect event) in the last 3 days — not every
    // radio ever tagged or currently live, since a radio that changed IP or hasn't connected
    // in weeks shouldn't clutter this list. See GET /api/logs/recent-radios.
    const API_URL = import.meta.env.VITE_API_URL || '/api';
    Promise.all([
      radioTagsApi.getAll(),
      axios.get<{ days: number; radios: { ip: string; lastSeen: string; lastEvent: string }[] }>(
        `${API_URL}/logs/recent-radios`, { params: { days: 3 } },
      ).then(r => r.data),
    ]).then(([tags, recent]) => {
      setRadioOptions(
        recent.radios
          .map(r => ({
            value: r.ip,
            label: tags[r.ip] ? `${r.ip} (${tags[r.ip]})` : r.ip,
            lastSeen: r.lastSeen,
          }))
          .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
          .map(({ value, label }) => ({ value, label })),
      );
    }).catch(() => {});
  }, []);

  const { logs, connected, clearLogs, logContainerRef } = useLogStream({
    source: 'open5gs',
    services: ALL_SERVICES,
    maxLines: 500,
    autoScroll: true,
    paused: false,
    majorEventsOnly: true,
    imsis: selectedImsis,
    radioIps: selectedRadioIps,
    eventTypes: selectedEventTypes as MajorEventType[],
  });

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    if (selectedEventTypes.length > 0) parts.push(`${selectedEventTypes.length} event type(s)`);
    if (selectedRadioIps.length > 0) parts.push(`${selectedRadioIps.length} radio(s)`);
    if (selectedImsis.length > 0) parts.push(`${selectedImsis.length} IMSI(s)`);
    return parts.length > 0 ? `Filtered to ${parts.join(' + ')}` : 'Showing all event types, radios, and IMSIs';
  }, [selectedEventTypes, selectedRadioIps, selectedImsis]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 p-3 border-b border-nms-border flex-wrap">
        <MultiSelectDropdown
          label="Event Types"
          options={EVENT_TYPE_OPTIONS}
          selected={selectedEventTypes}
          onChange={setSelectedEventTypes}
          placeholder="Search event types..."
        />
        <MultiSelectDropdown
          label="Radios"
          options={radioOptions}
          selected={selectedRadioIps}
          onChange={setSelectedRadioIps}
          placeholder="Search by IP or nickname..."
        />
        <MultiSelectDropdown
          label="IMSIs"
          options={imsiOptions}
          selected={selectedImsis}
          onChange={setSelectedImsis}
          placeholder="Search by IMSI or nickname..."
        />
        <span className="text-xs text-nms-text-dim">{filterSummary}</span>
        <div className="flex-1" />
        <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-nms-green' : 'text-nms-text-dim'}`}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-nms-green' : 'bg-nms-text-dim/40'}`} />
          {connected ? 'Connected' : 'Disconnected'}
        </span>
        <button onClick={clearLogs} className="nms-btn-ghost text-xs flex items-center gap-1.5">
          <Trash2 className="w-3.5 h-3.5" /> Clear
        </button>
      </div>

      <div ref={logContainerRef} className="flex-1 overflow-y-auto bg-nms-bg">
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-nms-text-dim gap-2">
            <RotateCw className="w-4 h-4 animate-spin" /> Waiting for major events (radio connects, UE attach/detach, PDU sessions)...
          </div>
        ) : (
          logs.map((log, i) => renderEventLine(log, i, setSelectedLog))
        )}
      </div>

      <div className="px-3 py-1.5 text-xs text-nms-text-dim border-t border-nms-border bg-nms-surface">
        Radio IP filtering only narrows radio connect/disconnect events — the raw logs don't
        carry radio IP on UE attach/PDU session lines, so those are filtered by IMSI only.
        Click any line to see it in context.
      </div>

      {selectedLog && (
        <LogContextModal
          service={selectedLog.service}
          timestamp={selectedLog.timestamp}
          message={selectedLog.message}
          onClose={() => setSelectedLog(null)}
        />
      )}
    </div>
  );
}
