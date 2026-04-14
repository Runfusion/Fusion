import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { IssueInfo, PrInfo } from "@fusion/core";

interface BadgeUpdatedMessage {
  type: "badge:updated";
  taskId: string;
  prInfo?: PrInfo | null;
  issueInfo?: IssueInfo | null;
  timestamp: string;
}

interface BadgeSnapshot {
  prInfo?: PrInfo | null;
  issueInfo?: IssueInfo | null;
  timestamp: string;
}

interface StoreSnapshot {
  badgeUpdates: Map<string, BadgeSnapshot>;
  isConnected: boolean;
}

class BadgeWebSocketStore {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private badgeUpdates = new Map<string, BadgeSnapshot>();
  private subscriptionsByTask = new Map<string, Set<string>>();
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1_000;
  private shouldReconnect = false;
  private isConnected = false;
  private projectId: string | null = null;
  private snapshot: StoreSnapshot = {
    badgeUpdates: new Map(),
    isConnected: false,
  };

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): StoreSnapshot {
    return this.snapshot;
  }

  setProjectId(projectId: string | null): void {
    if (this.projectId === projectId) return;

    const hadSubscriptions = this.subscriptionsByTask.size > 0;
    // Collect all (hookId, taskId) pairs that were subscribed
    const previousSubscriptions: Array<{ hookId: string; taskId: string }> = [];
    for (const [taskId, subscribers] of this.subscriptionsByTask) {
      for (const hookId of subscribers) {
        previousSubscriptions.push({ hookId, taskId });
      }
    }

    this.projectId = projectId;
    this.reset();

    // Re-subscribe to all previous subscriptions after project change
    // This ensures badge subscriptions survive project switches
    // Note: we restore subscriptions BEFORE calling connect() so that
    // onopen will send the subscribe messages over the new socket
    if (hadSubscriptions) {
      for (const { hookId, taskId } of previousSubscriptions) {
        this.subscriptionsByTask.set(taskId, new Set([hookId]));
      }
      this.shouldReconnect = this.subscriptionsByTask.size > 0;
      this.connect();
    }
  }

  subscribeTask(hookId: string, taskId: string): void {
    const subscribers = this.subscriptionsByTask.get(taskId) ?? new Set<string>();
    const beforeSize = subscribers.size;
    subscribers.add(hookId);
    this.subscriptionsByTask.set(taskId, subscribers);

    this.shouldReconnect = this.subscriptionsByTask.size > 0;
    this.connect();

    if (beforeSize === 0) {
      this.send({ type: "subscribe", taskId });
    }
  }

  unsubscribeTask(hookId: string, taskId: string): void {
    const subscribers = this.subscriptionsByTask.get(taskId);
    if (!subscribers) return;

    subscribers.delete(hookId);
    if (subscribers.size === 0) {
      this.subscriptionsByTask.delete(taskId);
      this.badgeUpdates.delete(taskId);
      this.send({ type: "unsubscribe", taskId });
      this.emit();
    }

    this.shouldReconnect = this.subscriptionsByTask.size > 0;
    if (!this.shouldReconnect) {
      this.disconnect();
    }
  }

  cleanupHook(hookId: string): void {
    for (const taskId of [...this.subscriptionsByTask.keys()]) {
      this.unsubscribeTask(hookId, taskId);
    }
  }

  reset(): void {
    this.disconnect();
    this.badgeUpdates.clear();
    this.subscriptionsByTask.clear();
    this.shouldReconnect = false;
    this.emit();
  }

  private connect(): void {
    if (!this.shouldReconnect || typeof window === "undefined") {
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    let url = `${protocol}//${window.location.host}/api/ws`;
    if (this.projectId) {
      url += `?projectId=${encodeURIComponent(this.projectId)}`;
    }
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.isConnected = true;
      this.reconnectDelayMs = 1_000;
      this.emit();

      for (const taskId of this.subscriptionsByTask.keys()) {
        this.send({ type: "subscribe", taskId });
      }
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as BadgeUpdatedMessage;
        if (message.type !== "badge:updated") {
          return;
        }

        const previous = this.badgeUpdates.get(message.taskId);
        this.badgeUpdates.set(message.taskId, {
          prInfo: hasMessageField(message, "prInfo") ? message.prInfo ?? null : previous?.prInfo,
          issueInfo: hasMessageField(message, "issueInfo") ? message.issueInfo ?? null : previous?.issueInfo,
          timestamp: message.timestamp,
        });
        this.emit();
      } catch {
        // Ignore malformed messages.
      }
    };

    ws.onclose = () => {
      this.ws = null;

      if (this.isConnected) {
        this.isConnected = false;
        this.emit();
      }

      if (!this.shouldReconnect) {
        return;
      }

      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // Closed socket is handled by onclose.
    };
  }

  private disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.close();
    }

    if (this.isConnected) {
      this.isConnected = false;
      this.emit();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) {
      return;
    }

    const delay = Math.min(this.reconnectDelayMs, 5_000);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      if (!this.shouldReconnect) {
        return;
      }

      this.connect();
    }, delay);

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 5_000);
  }

  private send(message: { type: "subscribe" | "unsubscribe"; taskId: string }): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.ws.send(JSON.stringify(message));
  }

  private emit(): void {
    this.snapshot = {
      badgeUpdates: new Map(this.badgeUpdates),
      isConnected: this.isConnected,
    };

    for (const listener of this.listeners) {
      listener();
    }
  }
}

const badgeWebSocketStore = new BadgeWebSocketStore();
let nextHookId = 0;

function hasMessageField(message: BadgeUpdatedMessage, field: "prInfo" | "issueInfo"): boolean {
  return Object.prototype.hasOwnProperty.call(message, field);
}

export function useBadgeWebSocket(projectId?: string): {
  badgeUpdates: Map<string, BadgeSnapshot>;
  isConnected: boolean;
  subscribeToBadge: (taskId: string) => void;
  unsubscribeFromBadge: (taskId: string) => void;
} {
  const hookIdRef = useRef<string | null>(null);
  if (hookIdRef.current === null) {
    hookIdRef.current = `badge-hook-${nextHookId++}`;
  }
  const snapshot = useSyncExternalStore(
    (listener) => badgeWebSocketStore.subscribe(listener),
    () => badgeWebSocketStore.getSnapshot(),
    () => badgeWebSocketStore.getSnapshot(),
  );

  const subscribeToBadge = useCallback((taskId: string) => {
    badgeWebSocketStore.subscribeTask(hookIdRef.current!, taskId);
  }, []);

  const unsubscribeFromBadge = useCallback((taskId: string) => {
    badgeWebSocketStore.unsubscribeTask(hookIdRef.current!, taskId);
  }, []);

  // Update project context when projectId changes
  useEffect(() => {
    badgeWebSocketStore.setProjectId(projectId ?? null);
  }, [projectId]);

  useEffect(() => {
    return () => {
      badgeWebSocketStore.cleanupHook(hookIdRef.current!);
    };
  }, []);

  return {
    badgeUpdates: snapshot.badgeUpdates,
    isConnected: snapshot.isConnected,
    subscribeToBadge,
    unsubscribeFromBadge,
  };
}

export function __resetBadgeWebSocketStoreForTests(): void {
  badgeWebSocketStore.reset();
  nextHookId = 0;
}
