import { useState, useEffect, useRef, useCallback } from 'react';

export type MajorEventType =
  | 'radio_connect' | 'radio_disconnect'
  | 'ue_attach' | 'ue_detach'
  | 'ue_register' | 'ue_deregister'
  | 'pdu_session_up' | 'pdu_session_down';

export interface LogEntry {
  timestamp: string;
  service: string;
  message: string;
  // Populated only when majorEventsOnly is set — see backend major-event-classifier.ts
  event?: { type: MajorEventType; imsi?: string; radioIp?: string; apn?: string };
}

interface UseLogStreamOptions {
  source: 'open5gs' | 'docker' | 'genieacs' | 'frr';
  services: string[];
  maxLines: number;
  autoScroll: boolean;
  paused: boolean;
  filter?: string; // e.g. 'sas' — server-side line filter
  // Major Events mode: classify+filter open5gs log lines server-side instead of streaming
  // everything. imsis/radioIps/eventTypes narrow further (empty/omitted = no restriction on
  // that axis) — combined with AND across axes, OR within each.
  majorEventsOnly?: boolean;
  imsis?: string[];
  radioIps?: string[];
  eventTypes?: MajorEventType[];
}

export const useLogStream = (options: UseLogStreamOptions) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const { services, maxLines, autoScroll, paused, source, filter, majorEventsOnly, imsis, radioIps, eventTypes } = options;

  // Connect to WebSocket
  useEffect(() => {
    const WS_URL = import.meta.env.VITE_WS_URL ||
      `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      console.log('WebSocket connected');
      setConnected(true);
    };

    ws.onmessage = (event) => {
      if (paused) return;

      try {
        const data = JSON.parse(event.data);

        if (data.type === 'log_entry') {
          setLogs((prev) => {
            const newLogs = [...prev, data.log];
            return newLogs.slice(-maxLines);
          });
        } else if (data.type === 'recent_logs') {
          setLogs(data.logs.slice(-maxLines));
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setConnected(false);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      setConnected(false);
    };

    wsRef.current = ws;

    return () => {
      ws.close();
    };
  }, [maxLines, paused]);

  // Subscribe to services (with debounce)
  useEffect(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    
    // Debounce subscription changes to avoid rapid re-subscribing
    const timeoutId = setTimeout(() => {
      if (services.length === 0) {
        // Unsubscribe
        wsRef.current?.send(JSON.stringify({ type: 'unsubscribe_logs' }));
        return;
      }

      const eventOptions = {
        ...(majorEventsOnly ? { majorEventsOnly: true } : {}),
        ...(imsis && imsis.length > 0 ? { imsis } : {}),
        ...(radioIps && radioIps.length > 0 ? { radioIps } : {}),
        ...(eventTypes && eventTypes.length > 0 ? { eventTypes } : {}),
      };

      // Subscribe with source
      wsRef.current?.send(JSON.stringify({
        type: 'subscribe_logs',
        source,
        services,
        ...(filter ? { filter } : {}),
        ...eventOptions,
      }));

      // Request recent logs — normal live-log views want a quick recent snapshot regardless
      // of maxLines, but the Major Events view wants as much of its (much rarer) history as
      // maxLines allows, so use it as the request limit in that mode.
      wsRef.current?.send(JSON.stringify({
        type: 'get_recent_logs',
        source,
        services,
        limit: majorEventsOnly ? maxLines : 100,
        ...(filter ? { filter } : {}),
        ...eventOptions,
      }));
    }, 300); // 300ms debounce

    return () => clearTimeout(timeoutId);
  }, [services, source, filter, majorEventsOnly, imsis, radioIps, eventTypes, maxLines]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = useCallback(() => {
    setLogs([]);
  }, []);

  return {
    logs,
    connected,
    clearLogs,
    logContainerRef,
  };
};
