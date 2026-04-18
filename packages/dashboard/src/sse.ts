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
} from "@fusion/core";
import type { AiSessionStore } from "./ai-session-store.js";

let activeConnections = 0;
let highWaterMark = 0;

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
 * Returns `true` if the write succeeded, `false` if the connection is dead.
 * On failure the caller should clean up event listeners.
 */
function safeWrite(res: Response, data: string): boolean {
  try {
    if (res.writableEnded || res.destroyed) return false;
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

function stripTaskListHeavyFields<T>(task: T): T {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return task;
  }

  if (!("log" in task)) {
    return task;
  }

  return { ...task, log: [] } as T;
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
) {
  const { projectId } = options ?? {};

  return (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    activeConnections++;
    // Track high water mark and log when new highs are reached
    if (activeConnections > highWaterMark) {
      highWaterMark = activeConnections;
      console.log(`[sse] active connections: ${activeConnections} (high water mark: ${highWaterMark})`);
    }

    // Send initial heartbeat
    res.write(": connected\n\n");

    /** Write an SSE message; clean up on failure. */
    const send = (data: string) => {
      if (!safeWrite(res, data)) cleanup();
    };

    // --- Event handler definitions ---
    /* eslint-disable @typescript-eslint/no-explicit-any -- EventEmitter handlers receive untyped event data */
    const onCreated = (task: any) => {
      send(`event: task:created\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onMoved = (data: any) => {
      send(`event: task:moved\ndata: ${JSON.stringify(stripTaskEventHeavyFields(data))}\n\n`);
    };
    const onUpdated = (task: any) => {
      send(`event: task:updated\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onDeleted = (task: any) => {
      send(`event: task:deleted\ndata: ${JSON.stringify(stripTaskListHeavyFields(task))}\n\n`);
    };
    const onMerged = (result: any) => {
      send(`event: task:merged\ndata: ${JSON.stringify(stripTaskEventHeavyFields(result))}\n\n`);
    };

    const onMissionCreated = (data: any) => {
      send(`event: mission:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionUpdated = (data: any) => {
      send(`event: mission:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionDeleted = (data: any) => {
      send(`event: mission:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneCreated = (data: any) => {
      send(`event: milestone:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneUpdated = (data: any) => {
      send(`event: milestone:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMilestoneDeleted = (data: any) => {
      send(`event: milestone:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceCreated = (data: any) => {
      send(`event: slice:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceUpdated = (data: any) => {
      send(`event: slice:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceDeleted = (data: any) => {
      send(`event: slice:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onSliceActivated = (data: any) => {
      send(`event: slice:activated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureCreated = (data: any) => {
      send(`event: feature:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureUpdated = (data: any) => {
      send(`event: feature:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureDeleted = (data: any) => {
      send(`event: feature:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onFeatureLinked = (data: any) => {
      send(`event: feature:linked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionCreated = (data: any) => {
      send(`event: assertion:created\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionUpdated = (data: any) => {
      send(`event: assertion:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionDeleted = (data: any) => {
      send(`event: assertion:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionLinked = (data: any) => {
      send(`event: assertion:linked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAssertionUnlinked = (data: any) => {
      send(`event: assertion:unlinked\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onMissionEvent = (data: any) => {
      send(`event: mission:event\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const onMilestoneValidationUpdated = (data: any) => {
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

    const onAiSessionUpdated = (data: any) => {
      send(`event: ai_session:updated\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onAiSessionDeleted = (data: any) => {
      send(`event: ai_session:deleted\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /* eslint-enable @typescript-eslint/no-explicit-any */

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
    const onAgentCreated = (agent: any) => {
      send(`event: agent:created\ndata: ${JSON.stringify(agent)}\n\n`);
    };

    const onAgentUpdated = (agent: any) => {
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
    const onChatSessionCreated = (session: any) => {
      send(`event: chat:session:created\ndata: ${JSON.stringify(session)}\n\n`);
    };

    const onChatSessionUpdated = (session: any) => {
      send(`event: chat:session:updated\ndata: ${JSON.stringify(session)}\n\n`);
    };

    const onChatSessionDeleted = (sessionId: string) => {
      send(`event: chat:session:deleted\ndata: ${JSON.stringify({ id: sessionId })}\n\n`);
    };

    const onChatMessageAdded = (message: any) => {
      send(`event: chat:message:added\ndata: ${JSON.stringify(message)}\n\n`);
    };

    const onChatMessageDeleted = (messageId: string) => {
      send(`event: chat:message:deleted\ndata: ${JSON.stringify({ id: messageId })}\n\n`);
    };

    // --- Cleanup (all handlers are defined above, safe to reference) ---

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeConnections--;
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
    };

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

    // Heartbeat every 30s to keep connection alive.
    // Sent as a named event so the client's EventSource can detect it
    // (SSE comments starting with ":" are silently consumed and never
    // fire event listeners in the browser).
    const heartbeat = setInterval(() => {
      send("event: heartbeat\ndata: \n\n");
    }, 30_000);

    // Register cleanup on request close (primary path for HTTP/1.1)
    _req.on("close", cleanup);

    // Also register on response close as a safety net for edge cases
    // (e.g., proxy timeouts, HTTP/2 stream resets). This ensures cleanup
    // fires even if the request object doesn't emit "close".
    // Guard with typeof check for test mocks that may not have on method.
    if (typeof res.on === "function") {
      res.on("close", cleanup);
    }
  };
}
