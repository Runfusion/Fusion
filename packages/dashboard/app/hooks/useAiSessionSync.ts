import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { AiSessionSummary } from "../api";

/*
FNXC:PlanningMultiTab 2026-07-14-00:00:
This store syncs AI session STATUS across tabs as a low-latency supplement to the server's
authoritative `ai_session:updated` SSE events — nothing more. It carries no notion of tab
ownership: the per-tab session lock (tab:active / tab:inactive / tab:heartbeat messages,
activeTabMap, owningTabId, and the stale-heartbeat sweep) was removed when AI interview
sessions became multi-tab. The persisted session row is the shared source of truth; any tab
may read and interact with any session.
*/

const CHANNEL_NAME = "fusion:ai-session-sync";
const STORAGE_FALLBACK_KEY = "fusion:ai-session-sync";

type SessionStatus = AiSessionSummary["status"];
type SessionType = AiSessionSummary["type"];

export interface SessionSyncState {
  sessionId: string;
  status: SessionStatus;
  needsInput: boolean;
  lastEventTimestamp: number;
  type?: SessionType;
  title?: string;
  projectId?: string | null;
  updatedAt?: string;
}

interface StorageFallbackEnvelope {
  id: string;
  message: AiSessionSyncMessage;
}

interface StoreSnapshot {
  tabId: string;
  sessions: Map<string, SessionSyncState>;
}

interface SessionUpdatePayload {
  sessionId: string;
  status: SessionStatus;
  needsInput?: boolean;
  timestamp?: number;
  type?: SessionType;
  title?: string;
  projectId?: string | null;
  updatedAt?: string;
}

interface SessionCompletedPayload {
  sessionId: string;
  status?: Extract<SessionStatus, "complete" | "error">;
  timestamp?: number;
}

type AiSessionSyncMessage =
  | {
      type: "session:updated";
      sessionId: string;
      status: SessionStatus;
      needsInput?: boolean;
      sessionType?: SessionType;
      title?: string;
      projectId?: string | null;
      updatedAt?: string;
      timestamp: number;
      senderTabId?: string;
    }
  | {
      type: "session:completed";
      sessionId: string;
      status?: Extract<SessionStatus, "complete" | "error">;
      timestamp: number;
      senderTabId?: string;
    }
  | {
      type: "sync:request";
      tabId: string;
      timestamp: number;
      senderTabId?: string;
    }
  | {
      type: "sync:response";
      tabId: string;
      sessions: SessionSyncState[];
      timestamp: number;
      senderTabId?: string;
    };

function now(): number {
  return Date.now();
}

function createTabId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }

  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseMessage(raw: unknown): AiSessionSyncMessage | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as { type?: unknown; timestamp?: unknown };
  if (typeof candidate.type !== "string") {
    return null;
  }

  if (typeof candidate.timestamp !== "number" || !Number.isFinite(candidate.timestamp)) {
    return null;
  }

  return raw as AiSessionSyncMessage;
}

export class AiSessionSyncStore {
  private readonly tabId: string;
  private readonly listeners = new Set<() => void>();
  private readonly sessionStates = new Map<string, SessionSyncState>();

  private snapshot: StoreSnapshot;
  private channel: BroadcastChannel | null = null;
  private usingStorageFallback = false;
  private cleanupStorageListener: (() => void) | null = null;

  constructor() {
    this.tabId = createTabId();
    this.snapshot = {
      tabId: this.tabId,
      sessions: new Map(),
    };

    if (!this.isBrowser()) {
      return;
    }

    this.initializeTransport();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): StoreSnapshot {
    return this.snapshot;
  }

  requestSync(): void {
    this.publish({
      type: "sync:request",
      tabId: this.tabId,
      timestamp: now(),
    });
  }

  broadcastUpdate(payload: SessionUpdatePayload): void {
    const timestamp = payload.timestamp ?? now();

    this.applySessionUpdate(
      {
        sessionId: payload.sessionId,
        status: payload.status,
        needsInput: payload.needsInput ?? payload.status === "awaiting_input",
        type: payload.type,
        title: payload.title,
        projectId: payload.projectId,
        updatedAt: payload.updatedAt,
      },
      timestamp,
    );

    this.publish({
      type: "session:updated",
      sessionId: payload.sessionId,
      status: payload.status,
      needsInput: payload.needsInput,
      sessionType: payload.type,
      title: payload.title,
      projectId: payload.projectId,
      updatedAt: payload.updatedAt,
      timestamp,
    });
  }

  broadcastCompleted(payload: SessionCompletedPayload): void {
    const status = payload.status ?? "complete";
    const timestamp = payload.timestamp ?? now();

    this.applySessionUpdate(
      {
        sessionId: payload.sessionId,
        status,
        needsInput: false,
      },
      timestamp,
    );

    this.publish({
      type: "session:completed",
      sessionId: payload.sessionId,
      status,
      timestamp,
    });
  }

  destroy(): void {
    this.cleanupStorageListener?.();
    this.cleanupStorageListener = null;

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  reset(): void {
    this.sessionStates.clear();

    this.snapshot = {
      tabId: this.tabId,
      sessions: new Map(),
    };

    this.emit();
  }

  private isBrowser(): boolean {
    return typeof window !== "undefined";
  }

  private initializeTransport(): void {
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (event: MessageEvent<unknown>) => {
          const parsed = parseMessage(event.data);
          if (parsed) {
            this.handleIncomingMessage(parsed);
          }
        };
        this.usingStorageFallback = false;
        return;
      } catch {
        // Fall back to localStorage below.
      }
    }

    this.usingStorageFallback = true;
    const storageHandler = (event: StorageEvent) => {
      if (event.key !== STORAGE_FALLBACK_KEY || !event.newValue) {
        return;
      }

      try {
        const parsedEnvelope = JSON.parse(event.newValue) as StorageFallbackEnvelope;
        const parsedMessage = parseMessage(parsedEnvelope.message);
        if (parsedMessage) {
          this.handleIncomingMessage(parsedMessage);
        }
      } catch {
        // Ignore malformed fallback payloads.
      }
    };

    window.addEventListener("storage", storageHandler);
    this.cleanupStorageListener = () => {
      window.removeEventListener("storage", storageHandler);
    };
  }

  private publish(message: AiSessionSyncMessage): void {
    const withSender: AiSessionSyncMessage = {
      ...message,
      senderTabId: this.tabId,
    };

    if (this.channel) {
      this.channel.postMessage(withSender);
      return;
    }

    if (!this.usingStorageFallback) {
      return;
    }

    try {
      const envelope: StorageFallbackEnvelope = {
        id: `${withSender.type}-${withSender.timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        message: withSender,
      };
      window.localStorage.setItem(STORAGE_FALLBACK_KEY, JSON.stringify(envelope));
    } catch {
      // Ignore fallback write failures.
    }
  }

  private handleIncomingMessage(message: AiSessionSyncMessage): void {
    switch (message.type) {
      case "session:updated": {
        this.applySessionUpdate(
          {
            sessionId: message.sessionId,
            status: message.status,
            needsInput: message.needsInput,
            type: message.sessionType,
            title: message.title,
            projectId: message.projectId,
            updatedAt: message.updatedAt,
          },
          message.timestamp,
        );
        return;
      }

      case "session:completed": {
        this.applySessionUpdate(
          {
            sessionId: message.sessionId,
            status: message.status ?? "complete",
            needsInput: false,
          },
          message.timestamp,
        );
        return;
      }

      case "sync:request": {
        if (message.tabId === this.tabId) {
          return;
        }

        this.publish({
          type: "sync:response",
          tabId: message.tabId,
          sessions: [...this.sessionStates.values()],
          timestamp: now(),
        });
        return;
      }

      case "sync:response": {
        if (message.tabId !== this.tabId) {
          return;
        }

        for (const session of message.sessions) {
          this.applySessionUpdate(
            {
              sessionId: session.sessionId,
              status: session.status,
              needsInput: session.needsInput,
              type: session.type,
              title: session.title,
              projectId: session.projectId,
              updatedAt: session.updatedAt,
            },
            session.lastEventTimestamp,
            false,
          );
        }

        this.emit();
        return;
      }

      default:
        return;
    }
  }

  private applySessionUpdate(
    update: {
      sessionId: string;
      status: SessionStatus;
      needsInput?: boolean;
      type?: SessionType;
      title?: string;
      projectId?: string | null;
      updatedAt?: string;
    },
    timestamp: number,
    shouldEmit = true,
  ): void {
    const existing = this.sessionStates.get(update.sessionId);
    if (existing && timestamp < existing.lastEventTimestamp) {
      return;
    }

    const nextState: SessionSyncState = {
      sessionId: update.sessionId,
      status: update.status,
      needsInput: update.needsInput ?? update.status === "awaiting_input",
      lastEventTimestamp: timestamp,
      type: update.type ?? existing?.type,
      title: update.title ?? existing?.title,
      projectId: update.projectId ?? existing?.projectId,
      updatedAt: update.updatedAt ?? new Date(timestamp).toISOString(),
    };

    this.sessionStates.set(update.sessionId, nextState);

    if (shouldEmit) {
      this.emit();
    }
  }

  private emit(): void {
    this.snapshot = {
      tabId: this.tabId,
      sessions: new Map(this.sessionStates),
    };

    for (const listener of this.listeners) {
      listener();
    }
  }
}

const aiSessionSyncStore = new AiSessionSyncStore();

export function useAiSessionSync(): {
  tabId: string;
  sessions: Map<string, SessionSyncState>;
  broadcastUpdate: (payload: SessionUpdatePayload) => void;
  broadcastCompleted: (payload: SessionCompletedPayload) => void;
  requestSync: () => void;
} {
  const snapshot = useSyncExternalStore(
    (listener) => aiSessionSyncStore.subscribe(listener),
    () => aiSessionSyncStore.getSnapshot(),
    () => aiSessionSyncStore.getSnapshot(),
  );

  useEffect(() => {
    aiSessionSyncStore.requestSync();
  }, []);

  const broadcastUpdate = useCallback((payload: SessionUpdatePayload) => {
    aiSessionSyncStore.broadcastUpdate(payload);
  }, []);

  const broadcastCompleted = useCallback((payload: SessionCompletedPayload) => {
    aiSessionSyncStore.broadcastCompleted(payload);
  }, []);

  const requestSync = useCallback(() => {
    aiSessionSyncStore.requestSync();
  }, []);

  return {
    tabId: snapshot.tabId,
    sessions: snapshot.sessions,
    broadcastUpdate,
    broadcastCompleted,
    requestSync,
  };
}

export function __resetAiSessionSyncStoreForTests(): void {
  aiSessionSyncStore.reset();
}

export function __destroyAiSessionSyncStoreForTests(): void {
  aiSessionSyncStore.destroy();
}
