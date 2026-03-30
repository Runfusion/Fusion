import { EventEmitter } from "node:events";
import type { IssueInfo, PrInfo } from "@kb/core";
import { WebSocket } from "ws";

export interface BadgeUpdate {
  prInfo?: PrInfo | null;
  issueInfo?: IssueInfo | null;
  timestamp?: string;
}

/** BadgeSnapshot is the full badge state with required timestamp for caching */
export interface BadgeSnapshot {
  prInfo?: PrInfo | null;
  issueInfo?: IssueInfo | null;
  timestamp: string;
}

export interface BadgeUpdatedMessage {
  type: "badge:updated";
  taskId: string;
  prInfo?: PrInfo | null;
  issueInfo?: IssueInfo | null;
  timestamp: string;
}

export interface WebSocketErrorMessage {
  type: "error";
  message: string;
}

export type BadgeServerMessage = BadgeUpdatedMessage | WebSocketErrorMessage;

export interface SubscribeMessage {
  type: "subscribe";
  taskId: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  taskId: string;
}

export type BadgeClientMessage = SubscribeMessage | UnsubscribeMessage;

interface ClientState {
  ws: WebSocket;
  subscriptions: Set<string>;
  isAlive: boolean;
  handlers: {
    pong: () => void;
    message: (raw: WebSocket.RawData) => void;
    close: () => void;
    error: () => void;
  };
}

export interface WebSocketManagerEvents {
  "client:connected": [clientId: string, totalClients: number];
  "client:disconnected": [clientId: string, totalClients: number];
  "subscription:changed": [taskId: string, subscriberCount: number];
}

export interface WebSocketManagerOptions {
  heartbeatIntervalMs?: number;
}

export class WebSocketManager extends EventEmitter<WebSocketManagerEvents> {
  private readonly clients = new Map<string, ClientState>();
  private readonly channelSubscribers = new Map<string, Set<string>>();
  private readonly heartbeatIntervalMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: WebSocketManagerOptions = {}) {
    super();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  }

  addClient(ws: WebSocket, clientId: string): void {
    this.removeClient(clientId);

    const handlers = this.createClientHandlers(clientId);
    const state: ClientState = {
      ws,
      subscriptions: new Set<string>(),
      isAlive: true,
      handlers,
    };

    this.clients.set(clientId, state);
    ws.on("pong", handlers.pong);
    ws.on("message", handlers.message);
    ws.on("close", handlers.close);
    ws.on("error", handlers.error);

    this.ensureHeartbeat();
    this.emit("client:connected", clientId, this.clients.size);
  }

  removeClient(clientId: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    state.ws.off("pong", state.handlers.pong);
    state.ws.off("message", state.handlers.message);
    state.ws.off("close", state.handlers.close);
    state.ws.off("error", state.handlers.error);

    for (const channel of state.subscriptions) {
      this.removeChannelSubscription(clientId, channel);
    }

    this.clients.delete(clientId);

    if (this.clients.size === 0) {
      this.clearHeartbeat();
    }

    this.emit("client:disconnected", clientId, this.clients.size);
  }

  subscribe(clientId: string, taskId: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    const channel = toBadgeChannel(taskId);
    if (state.subscriptions.has(channel)) return;

    state.subscriptions.add(channel);

    let subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) {
      subscribers = new Set<string>();
      this.channelSubscribers.set(channel, subscribers);
    }

    subscribers.add(clientId);
    this.emit("subscription:changed", taskId, subscribers.size);
  }

  unsubscribe(clientId: string, taskId: string): void {
    const channel = toBadgeChannel(taskId);
    this.removeChannelSubscription(clientId, channel);
  }

  broadcastBadgeUpdate(taskId: string, badgeData: BadgeUpdate): void {
    const subscribers = this.channelSubscribers.get(toBadgeChannel(taskId));
    if (!subscribers || subscribers.size === 0) return;

    const message: BadgeUpdatedMessage = {
      type: "badge:updated",
      taskId,
      timestamp: badgeData.timestamp ?? new Date().toISOString(),
      ...(badgeData.prInfo !== undefined ? { prInfo: badgeData.prInfo } : {}),
      ...(badgeData.issueInfo !== undefined ? { issueInfo: badgeData.issueInfo } : {}),
    };

    for (const clientId of subscribers) {
      const state = this.clients.get(clientId);
      if (!state) continue;
      if (!this.safeSend(state.ws, message)) {
        this.removeClient(clientId);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  hasClients(): boolean {
    return this.clients.size > 0;
  }

  getSubscriptionCount(taskId: string): number {
    return this.channelSubscribers.get(toBadgeChannel(taskId))?.size ?? 0;
  }

  getSubscribedTaskIds(): string[] {
    return [...this.channelSubscribers.entries()]
      .filter(([, subscribers]) => subscribers.size > 0)
      .map(([channel]) => fromBadgeChannel(channel));
  }

  dispose(): void {
    this.clearHeartbeat();

    for (const [clientId, state] of [...this.clients.entries()]) {
      state.ws.terminate();
      this.removeClient(clientId);
    }

    this.channelSubscribers.clear();
  }

  private createClientHandlers(clientId: string): ClientState["handlers"] {
    return {
      pong: () => {
        const state = this.clients.get(clientId);
        if (state) {
          state.isAlive = true;
        }
      },
      message: (raw) => {
        this.handleMessage(clientId, raw);
      },
      close: () => {
        this.removeClient(clientId);
      },
      error: () => {
        this.removeClient(clientId);
      },
    };
  }

  private handleMessage(clientId: string, raw: WebSocket.RawData): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      const state = this.clients.get(clientId);
      if (state) {
        this.safeSend(state.ws, { type: "error", message: parsed.error });
      }
      return;
    }

    if (parsed.value.type === "subscribe") {
      this.subscribe(clientId, parsed.value.taskId);
      return;
    }

    this.unsubscribe(clientId, parsed.value.taskId);
  }

  private removeChannelSubscription(clientId: string, channel: string): void {
    const state = this.clients.get(clientId);
    if (!state || !state.subscriptions.has(channel)) return;

    state.subscriptions.delete(channel);

    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) return;

    subscribers.delete(clientId);

    const taskId = fromBadgeChannel(channel);
    if (subscribers.size === 0) {
      this.channelSubscribers.delete(channel);
      this.emit("subscription:changed", taskId, 0);
      return;
    }

    this.emit("subscription:changed", taskId, subscribers.size);
  }

  private safeSend(ws: WebSocket, message: BadgeServerMessage): boolean {
    if (ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      for (const [clientId, state] of this.clients.entries()) {
        if (!state.isAlive) {
          state.ws.terminate();
          this.removeClient(clientId);
          continue;
        }

        state.isAlive = false;

        try {
          state.ws.ping();
        } catch {
          state.ws.terminate();
          this.removeClient(clientId);
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

function toBadgeChannel(taskId: string): string {
  return `badge:${taskId}`;
}

function fromBadgeChannel(channel: string): string {
  return channel.replace(/^badge:/, "");
}

function parseClientMessage(raw: WebSocket.RawData):
  | { ok: true; value: BadgeClientMessage }
  | { ok: false; error: string } {
  try {
    const decoded = typeof raw === "string"
      ? raw
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw).toString("utf-8")
        : Buffer.isBuffer(raw)
          ? raw.toString("utf-8")
          : Buffer.concat(raw as Buffer[]).toString("utf-8");

    const value = JSON.parse(decoded) as Partial<BadgeClientMessage>;

    if (value.type !== "subscribe" && value.type !== "unsubscribe") {
      return { ok: false, error: "Unsupported message type" };
    }

    if (typeof value.taskId !== "string" || value.taskId.trim().length === 0) {
      return { ok: false, error: "taskId is required" };
    }

    return {
      ok: true,
      value: {
        type: value.type,
        taskId: value.taskId.trim(),
      },
    };
  } catch {
    return { ok: false, error: "Invalid WebSocket message payload" };
  }
}
