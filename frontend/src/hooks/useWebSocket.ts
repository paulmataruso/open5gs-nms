import { useEffect, useRef } from 'react';
import { useServiceStore } from '../stores';

// If VITE_WS_URL is set (direct mode), use it. Otherwise derive from current
// page location so it works through nginx at /ws on the same host:port.
const WS_URL = import.meta.env.VITE_WS_URL ||
  `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

export function useWebSocket(): void {
  const wsRef = useRef<WebSocket | null>(null);
  const setStatuses = useServiceStore((s) => s.setStatuses);

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let ws: WebSocket;

    const connect = (): void => {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          if (msg.type === 'service_status') {
            setStatuses(msg.payload);
          }
        } catch {
          // ignore parse errors
        }
      };

      ws.onclose = () => {
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [setStatuses]);
}
