import { useState, useEffect, useRef, useCallback } from 'react';

export interface LogEntry {
  timestamp: string;
  service: string;
  message: string;
}

interface UseLogStreamOptions {
  services: string[];
  maxLines: number;
  autoScroll: boolean;
  paused: boolean;
}

export const useLogStream = (options: UseLogStreamOptions) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const { services, maxLines, autoScroll, paused } = options;

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

      // Subscribe
      wsRef.current?.send(JSON.stringify({
        type: 'subscribe_logs',
        services,
      }));

      // Request recent logs
      wsRef.current?.send(JSON.stringify({
        type: 'get_recent_logs',
        services,
        limit: 100,
      }));
    }, 300); // 300ms debounce

    return () => clearTimeout(timeoutId);
  }, [services]);

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
