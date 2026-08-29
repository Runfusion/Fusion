// AgentRuntime adapter for the ACP runtime.
//
// U3 implements the real session lifecycle: createSession spawns + handshakes
// (U2 connect()) then opens a `session/new`; promptWithFallback drives one
// prompt turn to its terminal stopReason; dispose tears down the connection
// (KTD4a — registry SIGKILL is authoritative). The `session/update` event
// bridge (U4) and the permission gate (U5) are wired in later units; for U3 the
// default client handler from U2 is used and a turn still resolves with a
// stopReason.

import { resolveCliSettings, type AcpCliSettings } from "./cli-spawn.js";
import type { AcpCallbacks } from "./types.js";
import {
  connect,
  newAcpSession,
  promptAcpSession,
  cancelAcpSession,
  createBridgingClientHandler,
} from "./provider.js";
import { buildSpawnEnv } from "./process-manager.js";
import { buildPromptBlocks, extractPromptImagesFromOptions } from "./prompt-builder.js";
import { startFusionToolBridge, type FusionToolBridge, type ToolLike } from "./tool-bridge.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  AcpSession,
} from "./types.js";

export class AcpRuntimeAdapter implements AgentRuntime {
  readonly id = "acp";
  readonly name = "ACP Runtime";
  private readonly settings: AcpCliSettings;

  constructor(settings?: Record<string, unknown>) {
    this.settings = resolveCliSettings(settings);
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const model = this.settings.model ?? options.defaultModelId ?? "acp";

    // Bridge streamed `session/update` notifications onto the engine callbacks
    // (U4) so ACP agents render like existing runtimes.
    const callbacks = {
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
    };

    /*
    FNXC:AcpSubscribeCompat 2026-08-21-18:40:
    The engine's AgentSession contract (pi-coding-agent) exposes
    `subscribe(handler)` and several production call sites call it
    unconditionally — executor/execute-workflow-step.ts and pi.ts fallback
    wiring do not use the `typeof === "function"` guard that reviewer.ts has.
    ACP sessions stream through the bridging client handler onto `callbacks`
    (createBridgingClientHandler → createEventBridge) instead of a pi
    subscription, so any unguarded call site crashed with
    "session.subscribe is not a function" the moment an ACP runtime
    (Hermes/Prime/Grok) executed a workflow step.

    Fix at the seam, not at every call site: wrap the raw callbacks so each
    forwarded text/thinking/tool event is ALSO replayed to subscribers as the
    pi-shaped event (`message_update` + `assistantMessageEvent`) that
    consumers parse, and expose `session.subscribe(handler)` returning an
    unsubscribe function that removes the handler. The bridging client
    handler below receives the WRAPPED callbacks so both delivery paths
    (original callbacks and subscriber replay) fire from one source.
    */
    const subscribers = new Set<(event: unknown) => void>();
    const emitToSubscribers = (event: Record<string, unknown>): void => {
      for (const handler of subscribers) {
        try {
          handler(event);
        } catch {
          // A faulty subscriber must never break the streaming bridge.
        }
      }
    };
    // FNXC:AcpSubscribeCompat 2026-08-21-20:16: contentIndex is per content block,
    // not per delta — keep it stable for all deltas in the same block.
    const TEXT_INDEX = 0;
    const THINKING_INDEX = 1;
    const bridgedCallbacks: AcpCallbacks = {
      onText: (delta: string) => {
        emitToSubscribers({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", contentIndex: TEXT_INDEX, delta },
        });
        callbacks.onText?.(delta);
      },
      onThinking: (delta: string) => {
        emitToSubscribers({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", contentIndex: THINKING_INDEX, delta },
        });
        callbacks.onThinking?.(delta);
      },
      onToolStart: (toolName: string, args?: unknown) => {
        emitToSubscribers({ type: "tool_execution_start", toolName, args });
        callbacks.onToolStart?.(toolName, args);
      },
      onToolEnd: (toolName: string, isError: boolean, result?: unknown) => {
        emitToSubscribers({ type: "tool_execution_end", toolName, isError, result });
        callbacks.onToolEnd?.(toolName, isError, result);
      },
    };

    // Build the bridging client handler with the per-run permission gate (U5):
    // its `requestPermission` classifies each call per-category against the live
    // gate (KTD3a) and selects `allow_once` only (S2). `cancelPending` drains
    // in-flight permission requests on teardown so the agent never deadlocks.
    // fs client capabilities (U7) are gated by settings — reads opt-in, writes
    // default OFF (KTD6) — and confined to the task cwd by the path jail. The
    // same toggles drive the advertised `fs` capability in connect() below, so
    // advertisement and registered handlers stay consistent.
    const { handler: clientHandler, cancelPending, resetTurn } = createBridgingClientHandler(
      bridgedCallbacks,
      options.actionGateContext,
      {
        cwd: options.cwd,
        allowRead: this.settings.fsRead,
        allowWrite: this.settings.fsWrite,
      },
      // Risk S1: unless the user acknowledged the untrusted-agent risk, a blanket
      // `allow` on a sensitive category is escalated to approval rather than
      // auto-approved — so the default `unrestricted` policy can't silently
      // green-light this untrusted subprocess.
      { allowUnrestricted: this.settings.allowUnrestricted },
    );

    // Spawn + initialize (U2). fs capabilities are advertised only where the
    // resolved settings enable them (KTD6); the subprocess env is built from the
    // allow-list, never inherited process.env (KTD6b).
    // Optional authenticate (Grok headless ACP: initialize → authenticate → session/new).
    const connection = await connect({
      binaryPath: this.settings.binaryPath,
      args: this.settings.args,
      cwd: options.cwd,
      env: buildSpawnEnv(this.settings.envAllowList, {
        required: this.settings.requiredEnv,
        /*
        FNXC:AcpTaskEnv 2026-08-21-18:40:
        `taskEnv` is the engine's contract for task-scoped subprocess env
        (AgentRuntimeOptions.taskEnv). Overlay it before filtering so task values
        win, while only keys admitted by the allow-list reach the subprocess —
        the allow-list stays the trust boundary (KTD6b).
        */
        sourceEnv: { ...process.env, ...options.taskEnv },
      }),
      advertiseFs: { read: this.settings.fsRead, write: this.settings.fsWrite },
      clientHandler,
      ...(this.settings.authenticate ? { authenticate: this.settings.authenticate } : {}),
    });

    // Open the ACP session over the task worktree. Forward MCP servers when the
    // caller supplied them (U10 — Route A); absent/empty keeps the Route B
    // read-only ask posture. Tool calls still route through the U5 permission floor.
    //
    // FNXC:AcpCustomTools 2026-08-16-00:30:
    // Engine customTools (fn_*) ride the same mcpServers channel: a loopback tool
    // bridge is started in-process and registered as a stdio MCP server so any
    // ACP agent (Hermes ACP, Prime, ...) can invoke Fusion closures. The bridge
    // is disposed on session/new failure and on session teardown.
    //
    // FNXC:GrokAcp 2026-07-11-14:00:
    // Callers (Grok runtime) may also pass `_meta` (pluginDirs / rules /
    // systemPromptOverride) via options.sessionMeta so agent-specific skill and
    // prompt setup rides on session/new without a second protocol hop.
    let toolBridge: FusionToolBridge | null = null;
    let toolBridgeFailure: "mcp-schema-server-missing" | "bridge-start-failed" | undefined;
    let sessionId: string;
    const customTools = Array.isArray(options.customTools) ? (options.customTools as ToolLike[]) : [];
    try {
      if (customTools.length > 0) {
        try {
          toolBridge = await startFusionToolBridge(customTools);
        } catch (error) {
          toolBridgeFailure = (error as { code?: string }).code === "mcp-schema-server-missing"
            ? "mcp-schema-server-missing"
            : "bridge-start-failed";
          options.onText?.(`FUSION_TOOL_BRIDGE_FAILED: ${toolBridgeFailure}`);
        }
      }
      const sessionMeta =
        options && typeof options === "object" && "sessionMeta" in options
          ? (options as { sessionMeta?: Record<string, unknown> }).sessionMeta
          : undefined;
      const opened = await newAcpSession(connection, {
        cwd: options.cwd,
        mcpServers: [...(options.mcpServers ?? []), ...(toolBridge ? [toolBridge.mcpServer] : [])],
        meta: sessionMeta,
      });
      sessionId = opened.sessionId;
    } catch (err) {
      // Don't leak the subprocess or the bridge if session/new fails after a
      // good handshake.
      await toolBridge?.dispose();
      connection.dispose();
      throw err;
    }

    let disposed = false;
    let bridgeDisposePromise: Promise<void> | undefined;
    let disposePromise = Promise.resolve();
    const disposeBridge = (): Promise<void> => {
      bridgeDisposePromise ??= toolBridge?.dispose() ?? Promise.resolve();
      return bridgeDisposePromise;
    };
    const session: AcpSession = {
      model,
      systemPrompt: options.systemPrompt,
      sessionId,
      cwd: options.cwd,
      lastModelDescription: `acp/${model}`,
      callbacks: bridgedCallbacks,
      fusionToolBridgeError: toolBridgeFailure ? { reasonCode: toolBridgeFailure } : undefined,
      // Persist the per-run gate (KTD3) so U5/U7 can reach the live action gate.
      gate: options.actionGateContext,
      connection,
      // Reset the event bridge's per-turn state at the start of each turn so a
      // turn that trips the per-turn output cap can't latch and suppress every
      // subsequent turn (FIX 1).
      resetTurn,
      disposeBridge,
      get disposePromise() {
        return disposePromise;
      },
      subscribe: (handler: (event: unknown) => void) => {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        subscribers.clear();
        // Drain in-flight permission requests BEFORE the registry kill so a
        // blocked agent is released (KTD4a — the SIGKILL is still authoritative).
        cancelPending();
        // Close the loopback tool bridge so no port or schema outlives the
        // session (idempotent).
        disposePromise = disposeBridge();
        connection.dispose();
      },
    };

    return { session };
  }

  async promptWithFallback(
    session: AgentSession,
    prompt: string,
    options?: unknown,
  ): Promise<{ stopReason?: string }> {
    const acp = session as AcpSession;
    if (!acp.connection) {
      throw new Error("ACP session has no live connection (createSession not completed)");
    }
    // Clear per-turn event-bridge state BEFORE driving the turn so tool
    // correlation, delta accumulators, and the output-cap latch all start clean
    // each turn (FIX 1). Without this, a turn that hit the per-turn output cap
    // would silently suppress all later turns.
    acp.resetTurn?.();
    /*
    FNXC:GrokAcp 2026-07-12-07:15:
    Chat/triage pass `{ images: [{ type:"image", data, mimeType }] }` through
    promptWithFallback. Previously options were ignored (`_options`) so Grok ACP
    and generic ACP sessions never received image ContentBlocks on session/prompt.
    */
    const images = extractPromptImagesFromOptions(options);
    const blocks = buildPromptBlocks(prompt, images ? { images } : undefined);
    // Resolve when the SDK prompt promise resolves — it already drains all
    // session/update notifications for the turn before reporting the stopReason.
    // The bridging client handler installed at createSession (U4) has already
    // surfaced streamed text/thinking/tool updates onto session.callbacks.
    /*
    FNXC:ACP-RouteB 2026-06-14-20:09:
    Route-B validation must distinguish clean end_turn answers from truncated or cancelled turns. Surface ACP stopReason to the engine runner instead of discarding it so callers can reject syntactically complete JSON recovered from incomplete output.
    */
    const stopReason = await promptAcpSession(acp.connection, acp.sessionId, blocks);
    return { stopReason };
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || "acp";
  }

  async dispose(session: AgentSession): Promise<void> {
    // KTD4a teardown: best-effort cancel of any in-flight turn, then force the
    // connection down. The process-registry SIGKILL is the authoritative
    // no-orphan guarantee, not the cancel round-trip. Idempotent.
    const acp = session as AcpSession;
    if (acp.connection && acp.sessionId) {
      await cancelAcpSession(acp.connection, acp.sessionId);
    }
    await acp.disposeBridge?.();
    session.dispose();
  }
}
