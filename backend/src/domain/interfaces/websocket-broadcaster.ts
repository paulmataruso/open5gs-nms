export interface WsMessage {
  type: string;
  payload: unknown;
}

export interface IWebSocketBroadcaster {
  broadcast(message: WsMessage): void;
  broadcastServiceStatus(status: unknown): void;
  broadcastTopology(topology: unknown): void;
  broadcastAuditLog(entry: unknown): void;
  getConnectionCount(): number;
}
