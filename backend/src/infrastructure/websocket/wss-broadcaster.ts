import { WebSocketServer, WebSocket } from 'ws';
import pino from 'pino';
import { IWebSocketBroadcaster, WsMessage } from '../../domain/interfaces/websocket-broadcaster';

export class WssBroadcaster implements IWebSocketBroadcaster {
  private clients: Set<WebSocket> = new Set();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly logger: pino.Logger,
  ) {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      this.logger.info({ connections: this.clients.size }, 'WebSocket client connected');

      ws.on('close', () => {
        this.clients.delete(ws);
        this.logger.info({ connections: this.clients.size }, 'WebSocket client disconnected');
      });

      ws.on('error', (err) => {
        this.logger.error({ err }, 'WebSocket error');
        this.clients.delete(ws);
      });

      // Send initial connection ack
      ws.send(
        JSON.stringify({ type: 'connected', payload: { timestamp: new Date().toISOString() } }),
      );
    });
  }

  broadcast(message: WsMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  broadcastServiceStatus(status: unknown): void {
    this.broadcast({ type: 'service_status', payload: status });
  }

  broadcastTopology(topology: unknown): void {
    this.broadcast({ type: 'topology', payload: topology });
  }

  broadcastAuditLog(entry: unknown): void {
    this.broadcast({ type: 'audit_log', payload: entry });
  }

  getConnectionCount(): number {
    return this.clients.size;
  }

  shutdown(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.wss?.close();
  }
}
