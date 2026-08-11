import { getAgentActivity, type AgentActivityEvent, type AgentActivitySseFrame } from "../api";
import { subscribeSse } from "../sse-bus";
import {
  ACTIVE_STATE_WINDOW_MS,
  compareActivityEvents,
  FLOW_EDGE_WINDOW_MS,
  getActivityEventAgeMs,
  parseActivityOccurredAt,
  withActivityWindowTimestamp,
} from "../components/agentsOrgChartActivity";

export const ACTIVITY_EVENT_CAP = 200;
export const ACTIVITY_EXPIRY_TICK_MS = 1_000;

export interface AgentActivitySnapshot {
  events: readonly AgentActivityEvent[];
  activityByAgentId: ReadonlyMap<string, AgentActivityEvent>;
  nowTick: number;
}

/*
FNXC:AgentActivityStore 2026-08-09-21:45:
AgentsView nests ActiveAgentsPanel, so independent hooks would double-fetch and create duplicate timers even though sse-bus already multiplexes sockets. This module singleton owns one seed, subscription, and expiry clock for every consumer.

The expiry interval is deliberately local clock work, not network polling: it publishes time decay so stale activity and flow affordances disappear without another request. Stop it when no retained event can still change.
*/
class AgentActivityStore {
  private listeners = new Set<() => void>();
  private retainers = new Map<string, string | undefined>();
  private events: AgentActivityEvent[] = [];
  private activityByAgentId = new Map<string, AgentActivityEvent>();
  private seenIds = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private abortController: AbortController | null = null;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private projectId: string | undefined;
  private contextVersion = 0;
  private closeVersion = 0;
  private snapshot: AgentActivitySnapshot = { events: [], activityByAgentId: new Map(), nowTick: Date.now() };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AgentActivitySnapshot => this.snapshot;

  retain(hookId: string, projectId?: string): void {
    const previousProject = this.projectId;
    this.retainers.set(hookId, projectId);
    this.closeVersion++;

    // A project change may happen on the sole retained hook after its effect cleanup.
    // Clear synchronously before opening so a new project never paints old activity.
    if (previousProject !== projectId) {
      this.switchProject(projectId);
      return;
    }

    if (this.retainers.size === 1) {
      if (this.unsubscribe) return;
      this.open(projectId);
    }
  }

  release(hookId: string): void {
    this.retainers.delete(hookId);
    if (this.retainers.size !== 0) return;

    // StrictMode replays effect cleanup/setup in the same microtask. Defer the final
    // close so a replay reuses the one stream instead of issuing a duplicate seed.
    const closeVersion = ++this.closeVersion;
    queueMicrotask(() => {
      if (this.retainers.size === 0 && this.closeVersion === closeVersion) this.close();
    });
  }

  private switchProject(projectId?: string): void {
    this.closeTransport();
    this.projectId = projectId;
    this.contextVersion++;
    this.events = [];
    this.activityByAgentId.clear();
    this.seenIds.clear();
    this.publish();
    this.openTransport();
  }

  private open(projectId?: string): void {
    this.projectId = projectId;
    this.contextVersion++;
    this.openTransport();
  }

  private openTransport(): void {
    const version = this.contextVersion;
    const query = this.projectId ? `?projectId=${encodeURIComponent(this.projectId)}` : "";
    const projectId = this.projectId;
    this.unsubscribe = subscribeSse(`/api/events${query}`, {
      events: { "agent:activity": (event) => this.handleFrame(event, version, projectId) },
      onReconnect: () => this.seed(version, projectId),
    });
    void this.seed(version, projectId);
  }

  private closeTransport(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.abortController?.abort();
    this.abortController = null;
    this.stopExpiryClock();
  }

  private close(): void {
    this.closeTransport();
  }

  private async seed(version: number, projectId: string | undefined): Promise<void> {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const page = await getAgentActivity({ limit: ACTIVITY_EVENT_CAP, projectId }, { signal: controller.signal });
      if (controller.signal.aborted || version !== this.contextVersion || projectId !== this.projectId) return;
      let changed = false;
      for (const event of page.events) changed = this.mergeEvent(event, projectId) || changed;
      if (changed) this.publish();
      this.updateExpiryClock();
    } catch {
      // A failed seed is intentionally no-data; the already-open stream remains live.
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private handleFrame(message: MessageEvent, version: number, projectId: string | undefined): void {
    if (version !== this.contextVersion || projectId !== this.projectId) return;
    try {
      const frame = JSON.parse(String(message.data)) as AgentActivitySseFrame;
      if ("truncated" in frame) {
        void this.seed(version, projectId);
        return;
      }
      if (this.mergeEvent(frame, projectId)) this.publish();
      this.updateExpiryClock();
    } catch {
      // Ignore malformed SSE frames.
    }
  }

  private mergeEvent(event: AgentActivityEvent, projectId: string | undefined): boolean {
    // The event URL is project-scoped, but validate frames and seed rows as a defense-in-depth
    // boundary: a stale or misrouted project frame must never populate a retained snapshot.
    if (projectId !== undefined && event?.projectId !== projectId) return false;
    if (!event || typeof event.eventId !== "string" || this.seenIds.has(event.eventId) || parseActivityOccurredAt(event.occurredAt) === null) return false;
    this.seenIds.add(event.eventId);
    this.events.push(withActivityWindowTimestamp(event, Date.now()));
    // Comparator order is newest-first; remove the tail so backfills cannot evict fresh activity.
    this.events.sort(compareActivityEvents);
    if (this.events.length > ACTIVITY_EVENT_CAP) this.events.pop();

    /*
    FNXC:AgentActivityRetention 2026-08-09-22:00:
    The latest-by-agent map must describe the bounded retained ring, not an unbounded
    historical cache. Rebuild it after oldest-key eviction so an evicted event cannot
    leave a node falsely active or idle; retain seen ids for this stream lifetime so
    a replay of that evicted event remains an idempotent no-op.
    */
    this.activityByAgentId.clear();
    for (const retained of this.events) {
      const current = this.activityByAgentId.get(retained.agentId);
      if (!current || compareActivityEvents(retained, current) < 0) {
        this.activityByAgentId.set(retained.agentId, retained);
      }
    }
    return true;
  }

  private canExpire(now: number): boolean {
    return this.events.some((event) => {
      const age = getActivityEventAgeMs(event, now);
      return age !== null && (age < ACTIVE_STATE_WINDOW_MS || age < FLOW_EDGE_WINDOW_MS);
    });
  }

  private updateExpiryClock(): void {
    if (this.retainers.size === 0 || !this.canExpire(Date.now()) || this.expiryTimer) return;
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      this.publish(now);
      if (!this.canExpire(now)) this.stopExpiryClock();
    }, ACTIVITY_EXPIRY_TICK_MS);
  }

  private stopExpiryClock(): void {
    if (!this.expiryTimer) return;
    clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }

  private publish(nowTick = Date.now()): void {
    this.snapshot = { events: [...this.events], activityByAgentId: new Map(this.activityByAgentId), nowTick };
    for (const listener of this.listeners) listener();
  }

  resetForTests(): void {
    this.closeTransport();
    this.listeners.clear();
    this.retainers.clear();
    this.events = [];
    this.activityByAgentId.clear();
    this.seenIds.clear();
    this.projectId = undefined;
    this.contextVersion = 0;
    this.closeVersion++;
    this.snapshot = { events: [], activityByAgentId: new Map(), nowTick: Date.now() };
  }
}

export const agentActivityStore = new AgentActivityStore();
export function __resetAgentActivityStoreForTests(): void { agentActivityStore.resetForTests(); }
