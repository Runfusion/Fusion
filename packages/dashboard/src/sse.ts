import type { Request, Response } from "express";
import type {
  TaskStore,
  MissionStore,
  PluginStore,
  PluginInstallation,
  PluginState,
  AgentStore,
  MessageStore,
  MissionValidatorRun,
  FixFeatureCreatedPayload,
  ChatStore,
  AutomationStore,
} from "@fusion/core";
import type { AiSessionStore } from "./ai-session-store.js";

let activeConnections = 0;
let highWaterMark = 0;
let nextConnectionId = 1;

const SSE_CLIENT_ID_MAX_LENGTH = 128;
const SSE_CLIENT_STALE_MS = 5_000;
// If a client's outbound buffer exceeds this, treat the connection as stuck
// and close it. Without this, res.write() silently queues into res.outputData
// for a paused/backgrounded client, and every store event for every entity
// accumulates there until the process OOMs.
const SSE_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

type SSECloseReason =
  | "backpressure"
  | "client-disconnect"
  | "close"
  | "error"
  | "request-aborted"
  | "send-failed"
  | "stale"
  | "superseded";

interface ManagedSSEConnection {
  id: number;
  clientId?: string;
  projectId?: string;
  close: (reason: SSECloseReason) => void;
  markAlive?: () => void;
}

const managedConnections = new Map<number, ManagedSSEConnection>();

function normalizeSSEClientId(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > SSE_CLIENT_ID_MAX_LENGTH) return undefined;
  if (!/^[a-zA-Z0-9._:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function registerManagedConnection(connection: ManagedSSEConnection): void {
  managedConnections.set(connection.id, connection);

  if (!connection.clientId) return;

  const superseded = Array.from(managedConnections.values()).filter((candidate) =>
    candidate.id !== connection.id &&
    candidate.clientId === connection.clientId &&
    candidate.projectId === connection.projectId
  );
  for (const existing of superseded) {
    existing.close("superseded");
  }
}

function unregisterManagedConnection(connectionId: number): void {
  managedConnections.delete(connectionId);
}

export function disconnectSSEClient(clientId: unknown, projectId?: string): number {
  const normalizedClientId = normalizeSSEClientId(clientId);
  if (!normalizedClientId) return 0;

  const matches = Array.from(managedConnections.values()).filter((connection) =>
    connection.clientId === normalizedClientId &&
    connection.projectId === projectId
  );
  for (const connection of matches) {
    connection.close("client-disconnect");
  }
  return matches.length;
}

export function markSSEClientAlive(clientId: unknown, projectId?: string): number {
  const normalizedClientId = normalizeSSEClientId(clientId);
  if (!normalizedClientId) return 0;

  const matches = Array.from(managedConnections.values()).filter((connection) =>
    connection.clientId === normalizedClientId &&
    connection.projectId === projectId
  );
  for (const connection of matches) {
    connection.markAlive?.();
  }
  return matches.length;
}

/** Returns the current number of active SSE connections. */
export function getActiveSSEConnections(): number {
  return activeConnections;
}

/** Returns the high water mark of SSE connections. */
export function getSSEHighWaterMark(): number {
  return highWaterMark;
}

/**
 * Safely write to an SSE response stream.
 * Returns "ok" on success, "dead" if the socket is gone, or "backpressure" if
 * the outbound buffer has grown past SSE_MAX_BUFFERED_BYTES (caller should
 * tear down — Node will otherwise queue indefinitely into res.outputData).
 */
type SafeWriteResult = "ok" | "dead" | "backpressure";

function safeWrite(res: Response, data: string): SafeWriteResult {
  try {
    if (res.writableEnded || res.destroyed) return "dead";
    // Pre-check: if the buffer is already full, refuse the write.
    if (typeof res.writableLength === "number" && res.writableLength > SSE_MAX_BUFFERED_BYTES) {
      return "backpressure";
    }
    res.write(data);
    return "ok";
  } catch {
    return "dead";
  }
}

function stripTaskListHeavyFields<T>(task: T): T {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return task;
  }

  if (!("log" in task)) {
    return task;
  }

  const candidate = task as Record<string, unknown>;
  const existingTimed = candidate.timedExecutionMs;
  // Mirror the slim REST path (listTasks): aggregate `[timing] … in <N>ms`
  // log entries before stripping the log so the board card has the same
  // total-execution figure on SSE updates as on the initial fetch.
  // Without this, `task:updated` events arrive with log=[] AND
  // timedExecutionMs=undefined, causing TaskCard to fall back to
  // workflow-only time and flicker every time an update lands.
  const timedExecutionMs =
    typeof existingTimed === "number"
      ? existingTimed
      : sumTimedLogEntries(candidate.log);

  return { ...task, log: [], timedExecutionMs } as T;
}

function sumTimedLogEntries(log: unknown): number {
  if (!Array.isArray(log)) return 0;
  let total = 0;
  for (const entry of log) {
    if (!entry || typeof entry !== "object") continue;
    const action = typeof (entry as { action?: unknown }).action === "string"
      ? ((entry as { action: string }).action)
      : "";
    const outcome = typeof (entry as { outcome?: unknown }).outcome === "string"
      ? ((entry as { outcome: string }).outcome)
      : "";
    if (!action.includes("[timing]") && !outcome.includes("[timing]")) continue;
    const match = `${action}\n${outcome}`.match(/(\d+(?:\.\d+)?)ms\b/i);
    if (!match) continue;
    const ms = Number(match[1]);
    if (Number.isFinite(ms)) total += ms;
  }
  return total;
}

function stripTaskEventHeavyFields<T>(payload: T): T {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  const candidate = payload as Record<string, unknown>;
  if ("task" in candidate) {
    return {
      ...candidate,
      task: stripTaskListHeavyFields(candidate.task),
    } as T;
  }

  return stripTaskListHeavyFields(payload);
}

/**
 * Normalized plugin lifecycle transition types.
 * These are the unified set of transitions that the SSE stream emits.
 */
export type PluginLifecycleTransition =
  | "installing"
  | "enabled"
  | "disabled"
  | "error"
  | "uninstalled"
  | "settings-updated";

/** Message event types forwarded through the SSE stream. */
export type MessageSseEventType =
  | "message:sent"
  | "message:received"
  | "message:read"
  | "message:deleted";

/**
 * Normalized plugin lifecycle payload emitted via SSE.
 * This is the stable contract the UI can reconcile.
 */
export interface PluginLifecyclePayload {
  /** Plugin identifier */
  pluginId: string;
  /** Normalized transition type */
  transition: PluginLifecycleTransition;
  /** Underlying store/runtime event that triggered this transition */
  sourceEvent: string;
  /** ISO-8601 timestamp of the event */
  timestamp: string;
  /** Project ID when stream is project-scoped (omitted for default streams) */
  projectId?: string;
  /** Whether the plugin is currently enabled */
  enabled: boolean;
  /** Current plugin state */
  state: PluginState;
  /** Plugin version */
  version: string;
  /** Plugin settings snapshot */
  settings: Record<string, unknown>;
  /** Error message (only present when state is "error") */
  error?: string;
}

/**
 * Map source event names to normalized plugin lifecycle transitions.
 * This ensures equivalent source events always map to the same transition value.
 */
function mapSourceEventToTransition(
  sourceEvent: string,
  plugin: PluginInstallation,
  _previousState?: PluginState,
): PluginLifecycleTransition {
  switch (sourceEvent) {
    case "plugin:registered":
      return "installing";

    case "plugin:enabled":
      return "enabled";

    case "plugin:disabled":
      return "disabled";

    case "plugin:stateChanged":
      // If the new state is "error", emit the "error" transition
      if (plugin.state === "error") {
        return "error";
      }
      // For other state changes (started, stopped), we don't emit a dedicated transition
      // but still emit the lifecycle event for observability
      return "error"; // Map to "error" as a fallback for non-standard state transitions

    case "plugin:unregistered":
      return "uninstalled";

    case "plugin:updated":
      // Check if this looks like a settings update
      // (we emit settings-updated for any update, as the UI can diff if needed)
      return "settings-updated";

    default:
      // Unknown events map to error for safety
      return "error";
  }
}

/**
 * Create a normalized plugin lifecycle payload from a source event.
 */
function createPluginLifecyclePayload(
  sourceEvent: string,
  plugin: PluginInstallation,
  projectId?: string,
): PluginLifecyclePayload {
  return {
    pluginId: plugin.id,
    transition: mapSourceEventToTransition(sourceEvent, plugin),
    sourceEvent,
    timestamp: new Date().toISOString(),
    projectId,
    enabled: plugin.enabled,
    state: plugin.state,
    version: plugin.version,
    settings: plugin.settings,
    error: plugin.error,
  };
}

export interface CreateSSEOptions {
  /** Project ID for project-scoped streams (enables scope attribution) */
  projectId?: string;
}

export function createSSE(
  store: TaskStore,
  missionStore?: MissionStore,
  aiSessionStore?: AiSessionStore,
  pluginStore?: PluginStore,
  options?: CreateSSEOptions,
  agentStore?: AgentStore,
  messageStore?: MessageStore,
  chatStore?: ChatStore,
  automationStore?: AutomationStore,
) {
  const { projectId } = options ?? {};

  return (_req: Request, res: Response) => {
    const connectionId = nextConnectionId++;
    const clientId = normalizeSSEClientId(_req.query?.clientId);
    const socket = res.socket ?? _req.socket;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    // This header discourages reuse after the stream ends, but Chrome may
    // still keep an EventSource transport alive during page unload. Cleanup is
    // therefore driven by explicit client ids and server-side reaping below.
    res.setHeader("Connection", "close");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    activeConnections++;
    // Track high water mark and log when new highs are reached
    if (activeConnections > highWaterMark) {
      highWaterMark = activeConnections;
    }
    console.log(`[sse] + connection (active=${activeConnections}, hwm=${highWaterMark})`);

    // Send initial heartbeat
    res.write(": connected\n\n");

    /** Write an SSE message; tear down on failure or backpressure. */
    const send = (data: string) => {
      const result = safeWrite(res, data);
      if (result === "ok") return;
      if (result === "backpressure") {
        console.warn(
          `[sse] connection ${connectionId} backpressure exceeded ` +
            `(buffered=${res.writableLength}B, threshold=${SSE_MAX_BUFFERED_BYTES}B); closing`,
        );
        closeConnection("backpressure");
        return;
      }
      // "dead" — socket already gone; cleanup is enough.
      cleanup("send-failed");
    };

    // --- Event handler definitions ---
    const onCreated = (task: unknown) => {
      send(`event: task:created\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onMoved = (data: unknown) => {
      send(`event: task:moved\ndata: ${JSON.stringify(stripTaskEventHeavyFields(data))}\n\n`);
    };
    const onUpdated = (task: unknown) => {
      send(`event: task:updated\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onDeleted = (task: unknown) => {
      send(`event: task:deleted\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onMerged = (result: unknown) => {
      send(`event: task:merged\ndata: ${JSON.stringify(stripTaskEventHeavyFields(result))}\n\n`);
    };

    const onMissionCreated = (data: unknown) => {
      send(`event: mission:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionUpdated = (data: unknown) => {
      send(`event: mission:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionDeleted = (data: unknown) => {
      send(`event: mission:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneCreated = (data: unknown) => {
      send(`event: milestone:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneUpdated = (data: unknown) => {
      send(`event: milestone:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneDeleted = (data: unknown) => {
      send(`event: milestone:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceCreated = (data: unknown) => {
      send(`event: slice:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceUpdated = (data: unknown) => {
      send(`event: slice:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceDeleted = (data: unknown) => {
      send(`event: slice:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceActivated = (data: unknown) => {
      send(`event: slice:activated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureCreated = (data: unknown) => {
      send(`event: feature:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureUpdated = (data: unknown) => {
      send(`event: feature:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureDeleted = (data: unknown) => {
      send(`event: feature:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureLinked = (data: unknown) => {
      send(`event: feature:linked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionCreated = (data: unknown) => {
      send(`event: assertion:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionUpdated = (data: unknown) => {
      send(`event: assertion:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionDeleted = (data: unknown) => {
      send(`event: assertion:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionLinked = (data: unknown) => {
      send(`event: assertion:linked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionUnlinked = (data: unknown) => {
      send(`event: assertion:unlinked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionEvent = (data: unknown) => {
      send(`event: mission:event\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onMilestoneValidationUpdated = (data: unknown) => {
      send(`event: milestone:validation:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onValidatorRunStarted = (run: MissionValidatorRun) => {
      send(`event: validator-run:started\ndata: ${JSON.stringify(run)}\n\n`);
    };

    const onValidatorRunCompleted = (run: MissionValidatorRun) => {
      send(`event: validator-run:completed\ndata: ${JSON.stringify(run)}\n\n`);
    };

    const onFixFeatureCreated = (payload: FixFeatureCreatedPayload) => {
      send(`event: fix-feature:created\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onAiSessionUpdated = (data: unknown) => {
      send(`event: ai_session:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAiSessionDeleted = (data: unknown) => {
      send(`event: ai_session:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // --- Unified plugin lifecycle handler ---
    // Instead of emitting individual plugin events, we normalize all plugin
    // lifecycle changes into a single `plugin:lifecycle` SSE event with
    // a deterministic payload contract.

    const onPluginRegistered = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:registered", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onPluginUnregistered = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:unregistered", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onPluginUpdated = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:updated", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onPluginEnabled = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:enabled", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onPluginDisabled = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:disabled", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const onPluginStateChanged = (plugin: PluginInstallation) => {
      const payload = createPluginLifecyclePayload("plugin:stateChanged", plugin, projectId);
      send(`event: plugin:lifecycle\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    // --- Agent lifecycle event handlers ---
    const onAgentCreated = (agent: unknown) => {
      send(`event: agent:created\ndata: ${JSON.stringify(agent)}\n\n`);
    };

    const onAgentUpdated = (agent: unknown) => {
      send(`event: agent:updated\ndata: ${JSON.stringify(agent)}\n\n`);
    };

    const onAgentDeleted = (agentId: string) => {
      send(`event: agent:deleted\ndata: ${JSON.stringify({ id: agentId })}\n\n`);
    };

    const onAgentStateChanged = (agentId: string, fromState: string, toState: string) => {
      send(`event: agent:stateChanged\ndata: ${JSON.stringify({ id: agentId, from: fromState, to: toState })}\n\n`);
    };

    // --- Message event handlers ---
    const onMessageSent = (message: unknown) => {
      send(`event: message:sent\ndata: ${JSON.stringify(message)}\n\n`);
    };

    const onMessageReceived = (message: unknown) => {
      send(`event: message:received\ndata: ${JSON.stringify(message)}\n\n`);
    };

    const onMessageRead = (message: unknown) => {
      send(`event: message:read\ndata: ${JSON.stringify(message)}\n\n`);
    };

    const onMessageDeleted = (messageId: string) => {
      send(`event: message:deleted\ndata: ${JSON.stringify({ id: messageId })}\n\n`);
    };

    // --- Chat store event handlers ---
    const onChatSessionCreated = (session: unknown) => {
      send(`event: chat:session:created\ndata: ${JSON.stringify(session)}\n\n`);
    };

    const onChatSessionUpdated = (session: unknown) => {
      send(`event: chat:session:updated\ndata: ${JSON.stringify(session)}\n\n`);
    };

    const onChatSessionDeleted = (sessionId: string) => {
      send(`event: chat:session:deleted\ndata: ${JSON.stringify({ id: sessionId })}\n\n`);
    };

    const onChatMessageAdded = (message: unknown) => {
      send(`event: chat:message:added\ndata: ${JSON.stringify(message)}\n\n`);
    };

    const onChatMessageDeleted = (messageId: string) => {
      send(`event: chat:message:deleted\ndata: ${JSON.stringify({ id: messageId })}\n\n`);
    };

    // --- Automation store event handlers ---
    const onScheduleCreated = (schedule: unknown) => {
      send(`event: schedule:created\ndata: ${JSON.stringify(schedule)}\n\n`);
    };

    const onScheduleUpdated = (schedule: unknown) => {
      send(`event: schedule:updated\ndata: ${JSON.stringify(schedule)}\n\n`);
    };

    const onScheduleDeleted = (schedule: unknown) => {
      send(`event: schedule:deleted\ndata: ${JSON.stringify(schedule)}\n\n`);
    };

    const onScheduleRun = (data: unknown) => {
      send(`event: schedule:run\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // --- Cleanup (all handlers are defined above, safe to reference) ---

    let cleaned = false;
    let clientStaleTimer: ReturnType<typeof setTimeout> | undefined;

    function resetClientStaleTimer(): void {
      if (!clientId) return;
      if (clientStaleTimer) clearTimeout(clientStaleTimer);
      clientStaleTimer = setTimeout(() => {
        closeConnection("stale");
      }, SSE_CLIENT_STALE_MS);
      clientStaleTimer.unref?.();
    }

    function cleanup(_reason: SSECloseReason = "close") {
      if (cleaned) return;
      cleaned = true;
      unregisterManagedConnection(connectionId);
      activeConnections--;
      console.log(`[sse] - connection (active=${activeConnections})`);
      if (clientStaleTimer) clearTimeout(clientStaleTimer);
      clearInterval(heartbeat);
      store.off("task:created", onCreated);
      store.off("task:moved", onMoved);
      store.off("task:updated", onUpdated);
      store.off("task:deleted", onDeleted);
      store.off("task:merged", onMerged);
      if (missionStore) {
        missionStore.off("mission:created", onMissionCreated);
        missionStore.off("mission:updated", onMissionUpdated);
        missionStore.off("mission:deleted", onMissionDeleted);
        missionStore.off("milestone:created", onMilestoneCreated);
        missionStore.off("milestone:updated", onMilestoneUpdated);
        missionStore.off("milestone:deleted", onMilestoneDeleted);
        missionStore.off("slice:created", onSliceCreated);
        missionStore.off("slice:updated", onSliceUpdated);
        missionStore.off("slice:deleted", onSliceDeleted);
        missionStore.off("slice:activated", onSliceActivated);
        missionStore.off("feature:created", onFeatureCreated);
        missionStore.off("feature:updated", onFeatureUpdated);
        missionStore.off("feature:deleted", onFeatureDeleted);
        missionStore.off("feature:linked", onFeatureLinked);
        missionStore.off("assertion:created", onAssertionCreated);
        missionStore.off("assertion:updated", onAssertionUpdated);
        missionStore.off("assertion:deleted", onAssertionDeleted);
        missionStore.off("assertion:linked", onAssertionLinked);
        missionStore.off("assertion:unlinked", onAssertionUnlinked);
        missionStore.off("mission:event", onMissionEvent);
        missionStore.off("milestone:validation:updated", onMilestoneValidationUpdated);
        missionStore.off("validator-run:started", onValidatorRunStarted);
        missionStore.off("validator-run:completed", onValidatorRunCompleted);
        missionStore.off("fix-feature:created", onFixFeatureCreated);
      }
      if (aiSessionStore) {
        aiSessionStore.off("ai_session:updated", onAiSessionUpdated);
        aiSessionStore.off("ai_session:deleted", onAiSessionDeleted);
      }
      if (pluginStore) {
        pluginStore.off("plugin:registered", onPluginRegistered);
        pluginStore.off("plugin:unregistered", onPluginUnregistered);
        pluginStore.off("plugin:updated", onPluginUpdated);
        pluginStore.off("plugin:enabled", onPluginEnabled);
        pluginStore.off("plugin:disabled", onPluginDisabled);
        pluginStore.off("plugin:stateChanged", onPluginStateChanged);
      }
      if (agentStore) {
        agentStore.off("agent:created", onAgentCreated);
        agentStore.off("agent:updated", onAgentUpdated);
        agentStore.off("agent:deleted", onAgentDeleted);
        agentStore.off("agent:stateChanged", onAgentStateChanged);
      }
      if (messageStore) {
        messageStore.off("message:sent", onMessageSent);
        messageStore.off("message:received", onMessageReceived);
        messageStore.off("message:read", onMessageRead);
        messageStore.off("message:deleted", onMessageDeleted);
      }
      if (chatStore) {
        chatStore.off("chat:session:created", onChatSessionCreated);
        chatStore.off("chat:session:updated", onChatSessionUpdated);
        chatStore.off("chat:session:deleted", onChatSessionDeleted);
        chatStore.off("chat:message:added", onChatMessageAdded);
        chatStore.off("chat:message:deleted", onChatMessageDeleted);
      }
      if (automationStore) {
        automationStore.off("schedule:created", onScheduleCreated);
        automationStore.off("schedule:updated", onScheduleUpdated);
        automationStore.off("schedule:deleted", onScheduleDeleted);
        automationStore.off("schedule:run", onScheduleRun);
      }
    }

    function closeConnection(reason: SSECloseReason): void {
      cleanup(reason);
      try {
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      } catch {
        // The socket may already be gone.
      }
      try {
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      } catch {
        // Ignore cleanup races with Node's own close path.
      }
    }

    // --- Subscribe ---

    store.on("task:created", onCreated);
    store.on("task:moved", onMoved);
    store.on("task:updated", onUpdated);
    store.on("task:deleted", onDeleted);
    store.on("task:merged", onMerged);

    if (missionStore) {
      missionStore.on("mission:created", onMissionCreated);
      missionStore.on("mission:updated", onMissionUpdated);
      missionStore.on("mission:deleted", onMissionDeleted);
      missionStore.on("milestone:created", onMilestoneCreated);
      missionStore.on("milestone:updated", onMilestoneUpdated);
      missionStore.on("milestone:deleted", onMilestoneDeleted);
      missionStore.on("slice:created", onSliceCreated);
      missionStore.on("slice:updated", onSliceUpdated);
      missionStore.on("slice:deleted", onSliceDeleted);
      missionStore.on("slice:activated", onSliceActivated);
      missionStore.on("feature:created", onFeatureCreated);
      missionStore.on("feature:updated", onFeatureUpdated);
      missionStore.on("feature:deleted", onFeatureDeleted);
      missionStore.on("feature:linked", onFeatureLinked);
      missionStore.on("assertion:created", onAssertionCreated);
      missionStore.on("assertion:updated", onAssertionUpdated);
      missionStore.on("assertion:deleted", onAssertionDeleted);
      missionStore.on("assertion:linked", onAssertionLinked);
      missionStore.on("assertion:unlinked", onAssertionUnlinked);
      missionStore.on("mission:event", onMissionEvent);
      missionStore.on("milestone:validation:updated", onMilestoneValidationUpdated);
      missionStore.on("validator-run:started", onValidatorRunStarted);
      missionStore.on("validator-run:completed", onValidatorRunCompleted);
      missionStore.on("fix-feature:created", onFixFeatureCreated);
    }

    if (aiSessionStore) {
      aiSessionStore.on("ai_session:updated", onAiSessionUpdated);
      aiSessionStore.on("ai_session:deleted", onAiSessionDeleted);
    }

    if (pluginStore) {
      pluginStore.on("plugin:registered", onPluginRegistered);
      pluginStore.on("plugin:unregistered", onPluginUnregistered);
      pluginStore.on("plugin:updated", onPluginUpdated);
      pluginStore.on("plugin:enabled", onPluginEnabled);
      pluginStore.on("plugin:disabled", onPluginDisabled);
      pluginStore.on("plugin:stateChanged", onPluginStateChanged);
    }

    if (agentStore) {
      agentStore.on("agent:created", onAgentCreated);
      agentStore.on("agent:updated", onAgentUpdated);
      agentStore.on("agent:deleted", onAgentDeleted);
      agentStore.on("agent:stateChanged", onAgentStateChanged);
    }

    if (messageStore) {
      messageStore.on("message:sent", onMessageSent);
      messageStore.on("message:received", onMessageReceived);
      messageStore.on("message:read", onMessageRead);
      messageStore.on("message:deleted", onMessageDeleted);
    }

    if (chatStore) {
      chatStore.on("chat:session:created", onChatSessionCreated);
      chatStore.on("chat:session:updated", onChatSessionUpdated);
      chatStore.on("chat:session:deleted", onChatSessionDeleted);
      chatStore.on("chat:message:added", onChatMessageAdded);
      chatStore.on("chat:message:deleted", onChatMessageDeleted);
    }

    if (automationStore) {
      automationStore.on("schedule:created", onScheduleCreated);
      automationStore.on("schedule:updated", onScheduleUpdated);
      automationStore.on("schedule:deleted", onScheduleDeleted);
      automationStore.on("schedule:run", onScheduleRun);
    }

    // Heartbeat every 30s to keep connection alive.
    // Sent as a named event so the client's EventSource can detect it
    // (SSE comments starting with ":" are silently consumed and never
    // fire event listeners in the browser).
    registerManagedConnection({
      id: connectionId,
      clientId,
      projectId,
      close: closeConnection,
      markAlive: resetClientStaleTimer,
    });
    resetClientStaleTimer();

    const heartbeat = setInterval(() => {
      send("event: heartbeat\ndata: \n\n");
    }, 30_000);

    // Register cleanup on request close (primary path for HTTP/1.1)
    _req.on("close", () => cleanup("close"));
    _req.on("aborted", () => closeConnection("request-aborted"));

    // Also register on response close as a safety net for edge cases
    // (e.g., proxy timeouts, HTTP/2 stream resets). This ensures cleanup
    // fires even if the request object doesn't emit "close".
    // Guard with typeof check for test mocks that may not have on method.
    if (typeof res.on === "function") {
      res.on("close", () => cleanup("close"));
    }

    // Socket events still handle normal disconnects and low-level errors. The
    // client-id registry above covers browser unload cases where Chrome keeps
    // the HTTP/1.1 transport alive and no close event arrives promptly.
    if (socket) {
      if (typeof socket.setKeepAlive === "function") {
        socket.setKeepAlive(true, 10_000);
      }
      if (typeof socket.on === "function") {
        socket.on("close", () => cleanup("close"));
        socket.on("error", () => closeConnection("error"));
      }
    }
  };
}
