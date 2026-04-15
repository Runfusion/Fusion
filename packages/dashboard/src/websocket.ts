import { EventEmitter } from "node:events";
import type { IssueInfo, PrInfo } from "@fusion/core";
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
  projectId?: string;
}

export interface UnsubscribeMessage {
  type: "unsubscribe";
  taskId: string;
  projectId?: string;
}

export type BadgeClientMessage = SubscribeMessage | UnsubscribeMessage;

interface ClientState {
  ws: WebSocket;
  /** Subscribed channels (e.g., "badge:project-123:FN-001") */
  subscriptions: Set<string>;
  /** The project scope this client is bound to */
  projectId: string;
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
  "subscription:changed": [taskId: string, subscriberCount: number, projectId: string];
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

  /**
   * Add a new client to the manager.
   * @param ws - The WebSocket connection
   * @param clientId - Unique identifier for this client
   * @param projectId - The project scope this client is bound to (defaults to "default")
   */
  addClient(ws: WebSocket, clientId: string, projectId: string = "default"): void {
    this.removeClient(clientId);

    const handlers = this.createClientHandlers(clientId);
    const state: ClientState = {
      ws,
      subscriptions: new Set<string>(),
      projectId,
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

  /**
   * Subscribe a client to badge updates for a task within their project scope.
   * @param clientId - The client ID to subscribe
   * @param taskId - The task ID to subscribe to
   * @param projectIdOverride - Optional project scope override (uses client's bound scope if not provided)
   */
  subscribe(clientId: string, taskId: string, projectIdOverride?: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    // Use client's bound scope by default, or override if explicitly provided
    const scopeKey = projectIdOverride ?? state.projectId;
    const channel = toBadgeChannel(scopeKey, taskId);
    if (state.subscriptions.has(channel)) return;

    state.subscriptions.add(channel);

    let subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) {
      subscribers = new Set<string>();
      this.channelSubscribers.set(channel, subscribers);
    }

    subscribers.add(clientId);
    this.emit("subscription:changed", taskId, subscribers.size, scopeKey);
  }

  /**
   * Unsubscribe a client from badge updates for a task.
   * @param clientId - The client ID to unsubscribe
   * @param taskId - The task ID to unsubscribe from
   * @param projectIdOverride - Optional project scope override (uses client's bound scope if not provided)
   */
  unsubscribe(clientId: string, taskId: string, projectIdOverride?: string): void {
    const state = this.clients.get(clientId);
    if (!state) return;

    const scopeKey = projectIdOverride ?? state.projectId;
    const channel = toBadgeChannel(scopeKey, taskId);
    this.removeChannelSubscription(clientId, channel);
  }

  /**
   * Broadcast a badge update to all clients subscribed to the task within the scope.
   * @param taskId - The task ID
   * @param badgeData - The badge data to broadcast
   * @param projectId - Optional project scope (defaults to "default")
   */
  broadcastBadgeUpdate(taskId: string, badgeData: BadgeUpdate, projectId?: string): void {
    const scopeKey = projectId ?? "default";
    const subscribers = this.channelSubscribers.get(toBadgeChannel(scopeKey, taskId));
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

  /**
   * Get subscription count for a task within a project scope.
   * @param taskId - The task ID
   * @param projectId - Optional project scope (defaults to "default")
   */
  getSubscriptionCount(taskId: string, projectId?: string): number {
    const scopeKey = projectId ?? "default";
    return this.channelSubscribers.get(toBadgeChannel(scopeKey, taskId))?.size ?? 0;
  }

  /**
   * Get all subscribed task IDs, optionally filtered by project scope.
   * @param projectId - Optional project scope filter (returns all if not specified)
   */
  getSubscribedTaskIds(projectId?: string): string[] {
    const scopeKey = projectId ?? "default";
    const prefix = `badge:${scopeKey}:`;
    return [...this.channelSubscribers.entries()]
      .filter(([channel, subscribers]) => subscribers.size > 0 && channel.startsWith(prefix))
      .map(([channel]) => fromBadgeChannel(scopeKey, channel));
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
      this.subscribe(clientId, parsed.value.taskId, parsed.value.projectId);
      return;
    }

    this.unsubscribe(clientId, parsed.value.taskId, parsed.value.projectId);
  }

  private removeChannelSubscription(clientId: string, channel: string): void {
    const state = this.clients.get(clientId);
    if (!state || !state.subscriptions.has(channel)) return;

    state.subscriptions.delete(channel);

    const subscribers = this.channelSubscribers.get(channel);
    if (!subscribers) return;

    subscribers.delete(clientId);

    // Extract taskId and projectId from channel for the event
    const { taskId, projectId } = extractPartsFromChannel(channel);
    if (subscribers.size === 0) {
      this.channelSubscribers.delete(channel);
      this.emit("subscription:changed", taskId ?? "", 0, projectId ?? "default");
      return;
    }

    this.emit("subscription:changed", taskId ?? "", subscribers.size, projectId ?? "default");
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

/**
 * Create a badge channel key with project scope.
 * Format: badge:{projectId}:{taskId}
 *
 * IMPORTANT: This channel key format is critical for multi-project isolation.
 * The colon-separated format (`badge:project-a:FN-001`) ensures that overlapping
 * task IDs across projects (e.g., "FN-001" in both project-a and project-b)
 * cannot share badge state. Each project's badge updates are routed to clients
 * subscribed to their project's specific channel key.
 */
function toBadgeChannel(projectId: string, taskId: string): string {
  return `badge:${projectId}:${taskId}`;
}

/**
 * Extract taskId from a badge channel key given a known projectId.
 */
function fromBadgeChannel(projectId: string, channel: string): string {
  const prefix = `badge:${projectId}:`;
  return channel.startsWith(prefix) ? channel.slice(prefix.length) : channel;
}

/**
 * Extract taskId and projectId from any badge channel key.
 * Used for event emission when we need both values but only have the channel string.
 *
 * The regex pattern /^badge:([^:]+):(.+)$/ captures:
 *   - match[1]: projectId (everything between "badge:" and the next colon)
 *   - match[2]: taskId (everything after the second colon)
 *
 * This parsing is necessary because channel subscribers store only the channel string,
 * but we need the projectId and taskId separately for event emission.
 */
function extractPartsFromChannel(channel: string): { taskId: string | null; projectId: string | null } {
  // Channel format: badge:{projectId}:{taskId}
  const match = channel.match(/^badge:([^:]+):(.+)$/);
  if (match) {
    return { projectId: match[1], taskId: match[2] };
  }
  return { projectId: null, taskId: null };
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

    // projectId is optional - validates that it's a non-empty string if provided
    if (value.projectId !== undefined && (typeof value.projectId !== "string" || value.projectId.trim().length === 0)) {
      return { ok: false, error: "projectId must be a non-empty string" };
    }

    return {
      ok: true,
      value: {
        type: value.type,
        taskId: value.taskId.trim(),
        projectId: value.projectId?.trim(),
      },
    };
  } catch {
    return { ok: false, error: "Invalid WebSocket message payload" };
  }
}
