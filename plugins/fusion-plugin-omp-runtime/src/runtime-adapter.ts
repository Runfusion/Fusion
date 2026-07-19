import { AcpRuntimeAdapter } from "./acp/index.js";
import {
  buildOmpAcpRuntimeSettings,
  modelForCli,
  normalizeOmpCliModel,
} from "./acp-settings.js";
import { toAcpMcpServers, type AcpMcpServer } from "./mcp-forwarding.js";
import { resolveOmpModelSelector } from "./process-manager.js";
import {
  startFusionToolBridge,
  type FusionToolBridge,
  type ToolLike,
} from "./tool-bridge.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  OmpSession,
} from "./types.js";

/*
FNXC:OmpAcp 2026-07-11-23:35:
Drive Oh My Pi over native ACP (`omp acp`) via vendored AcpRuntimeAdapter under
./acp/. Realtime session/update streaming, tool calls, multi-turn session reuse.
Keep resolve-never-reject on prompt failures so chat/executor always get a
well-formed turn; surface create/prompt failures as visible onText diagnostics
rather than silent empty bubbles (FN-7779 invariant, same as Grok ACP).

FNXC:OmpAcp 2026-07-14-00:05:
Load Fusion tools + operator MCP into the ACP session for full fn_* parity with
Grok ACP:
  - Operator MCP servers → session/new.mcpServers (stdio/http/sse)
  - Engine customTools (fn_*) → loopback MCP bridge + fusion-custom-tools server
  - System rules describe available Fusion MCP tools so omp prefers them for board ops

FNXC:OmpAcp 2026-07-18-16:40:
Resolve bare picker ids (MiniMax-M2.5) to provider-qualified selectors before
`omp --model … acp` so multi-provider collisions do not land on an unauthenticated
plan provider and return JSON-RPC Internal error.
*/

export type AcpAdapterFactory = (settings: Record<string, unknown>) => {
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(
    session: AgentSession,
    prompt: string,
    options?: unknown,
  ): Promise<void | { stopReason?: string }>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
};

export interface OmpRuntimeAdapterOptions {
  /** Binary name/path to invoke. Defaults to "omp" (PATH resolution). */
  binary?: string;
  /**
   * Injectable ACP adapter factory for tests. Production uses
   * `AcpRuntimeAdapter` with OMP ACP settings.
   */
  createAcpAdapter?: AcpAdapterFactory;
}

/** Turn-scoped stream accumulators stored on the session for prompt finalization. */
interface TurnAccum {
  text: string;
}

interface SessionResources {
  toolBridge?: FusionToolBridge | null;
}

const TURN_ACCUM = Symbol("ompTurnAccum");
const SESSION_RESOURCES = Symbol("ompSessionResources");

type SessionWithExtras = OmpSession & {
  [TURN_ACCUM]?: TurnAccum;
  [SESSION_RESOURCES]?: SessionResources;
};

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeCreateFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(
    `OMP ACP failed to start: ${reason}. Ensure the \`omp\` binary is installed and authenticated (` +
      `\`omp acp\`, credentials under ~/.omp), or set provider API keys in the environment.`,
  );
}

function describePromptFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(`OMP ACP turn failed: ${reason}`);
}

function appendMessage(session: OmpSession, role: "user" | "assistant", content: string): void {
  const entry = { role, content };
  session.state.messages.push(entry);
  if (session.messages !== session.state.messages) {
    session.messages.push(entry);
  }
}

function getTurnAccum(session: OmpSession): TurnAccum {
  const s = session as SessionWithExtras;
  if (!s[TURN_ACCUM]) {
    s[TURN_ACCUM] = { text: "" };
  }
  return s[TURN_ACCUM];
}

function resetTurnAccum(session: OmpSession): void {
  getTurnAccum(session).text = "";
}

function collectCustomTools(options: AgentRuntimeOptions): ToolLike[] {
  const fromCustom = Array.isArray(options.customTools) ? (options.customTools as ToolLike[]) : [];
  /*
  FNXC:OmpAcp 2026-07-14-00:05:
  AgentRuntimeOptions.tools is typed as "coding"|"readonly"|undefined, but some call sites pass
  an array of ToolDefinitions. Narrow via Array.isArray on the tools field, then cast the array
  value only — never cast the whole options object (TS2352).
  */
  const toolsField = (options as { tools?: unknown }).tools;
  const maybeToolsArray = Array.isArray(toolsField) ? (toolsField as ToolLike[]) : [];
  return [...fromCustom, ...maybeToolsArray];
}

/**
 * System rules so omp knows Fusion board tools are available via the
 * fusion-custom-tools MCP server (not only omp-native tools).
 */
export function buildOmpFusionToolRules(options: {
  fusionToolCount?: number;
  operatorMcpCount?: number;
}): string {
  const parts: string[] = [];
  if ((options.fusionToolCount ?? 0) > 0) {
    parts.push(
      [
        "## Fusion board tools (MCP: fusion-custom-tools)",
        `You have access to ${options.fusionToolCount} Fusion in-process tools (names typically start with \`fn_\`) via the MCP server \`fusion-custom-tools\`.`,
        "Use them for Fusion board/task/agent/workflow operations instead of inventing shell workarounds.",
        "Prefer these tools whenever the user or system prompt asks about tasks, missions, agents, or Fusion state.",
      ].join("\n"),
    );
  }
  if ((options.operatorMcpCount ?? 0) > 0) {
    parts.push(
      [
        "## Operator MCP servers",
        `${options.operatorMcpCount} additional operator-configured MCP server(s) are connected for this session.`,
        "Use them when they match the user's request.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

function ensureOmpSessionShape(
  session: AgentSession,
  model: string,
  options: AgentRuntimeOptions,
  turnAccum: TurnAccum,
  resources: SessionResources,
): OmpSession {
  const messages: unknown[] =
    Array.isArray((session as OmpSession).messages) ? (session as OmpSession).messages : [];
  const existingState = (session as { state?: OmpSession["state"] }).state;
  const state: OmpSession["state"] = existingState ?? { messages };
  if (!Array.isArray(state.messages)) {
    state.messages = messages;
  }

  const omp = session as OmpSession;
  omp.model = model;
  omp.systemPrompt = omp.systemPrompt ?? options.systemPrompt;
  omp.messages = state.messages;
  omp.state = state;
  omp.lastModelDescription = `omp/${model}`;
  omp.callbacks = {
    onText: omp.callbacks?.onText ?? options.onText,
    onThinking: omp.callbacks?.onThinking ?? options.onThinking,
    onToolStart: omp.callbacks?.onToolStart ?? options.onToolStart,
    onToolEnd: omp.callbacks?.onToolEnd ?? options.onToolEnd,
  };

  const originalDispose = typeof omp.dispose === "function" ? omp.dispose.bind(omp) : () => undefined;
  omp.dispose = () => {
    void resources.toolBridge?.dispose();
    originalDispose();
  };

  (omp as SessionWithExtras)[TURN_ACCUM] = turnAccum;
  (omp as SessionWithExtras)[SESSION_RESOURCES] = resources;
  return omp;
}

function createDeadSession(
  model: string,
  options: AgentRuntimeOptions,
  diagnostic: string,
  resources?: SessionResources,
): OmpSession {
  const messages: unknown[] = [];
  return {
    model,
    systemPrompt: options.systemPrompt,
    messages,
    state: { messages, errorMessage: diagnostic },
    sessionId: undefined,
    lastModelDescription: `omp/${model}`,
    callbacks: {
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
    },
    dispose: () => {
      void resources?.toolBridge?.dispose();
    },
  };
}

export class OmpRuntimeAdapter implements AgentRuntime {
  readonly id = "omp";
  readonly name = "OMP Runtime";
  private readonly binary: string;
  private readonly createAcpAdapter: AcpAdapterFactory;
  /** Per-session ACP adapter so model-specific spawn args stay consistent. */
  private readonly adapters = new WeakMap<object, ReturnType<AcpAdapterFactory>>();

  constructor(options?: OmpRuntimeAdapterOptions) {
    this.binary = options?.binary ?? "omp";
    /*
    FNXC:OmpAcp 2026-07-11-23:35:
    AcpRuntimeAdapter returns ACP AgentSession shapes; AcpAdapterFactory is typed
    against Omp AgentSessionResult. createSession always runs ensureOmpSessionShape
    after ACP create, so the production factory is a deliberate structural bridge
    via unknown rather than unifying the two session interfaces here.
    */
    this.createAcpAdapter =
      options?.createAcpAdapter ??
      ((settings) => new AcpRuntimeAdapter(settings) as unknown as ReturnType<AcpAdapterFactory>);
  }

  async createSession(
    options: AgentRuntimeOptions = {
      cwd: process.cwd(),
      systemPrompt: "",
    },
  ): Promise<AgentSessionResult> {
    const rawModel = normalizeOmpCliModel(options.defaultModelId) ?? "omp/default";
    /*
    FNXC:OmpAcp 2026-07-18-16:40:
    Bare ids from the omp-cli picker can map to multiple upstream providers.
    Resolve to a unique `provider/id` selector before spawn so authenticated
    providers (e.g. minimax-code) win over unauthenticated plan aliases.
    */
    const model =
      (await resolveOmpModelSelector(this.binary, modelForCli(rawModel) ?? rawModel))
      ?? rawModel;
    const turnAccum: TurnAccum = { text: "" };
    const resources: SessionResources = {};

    // ── Operator MCP + Fusion custom tools (fn_*) ─────────────────────────
    const operatorMcp = toAcpMcpServers(options.mcpServers);
    let toolBridge: FusionToolBridge | null = null;
    try {
      toolBridge = await startFusionToolBridge(collectCustomTools(options));
      resources.toolBridge = toolBridge;
    } catch {
      toolBridge = null;
    }

    const mcpServers: AcpMcpServer[] = [
      ...operatorMcp,
      ...(toolBridge ? [toolBridge.mcpServer] : []),
    ];

    const toolRules = buildOmpFusionToolRules({
      fusionToolCount: toolBridge?.toolCount,
      operatorMcpCount: operatorMcp.length,
    });

    const systemPromptParts = [options.systemPrompt?.trim() ?? "", toolRules].filter(
      (part) => part.length > 0,
    );
    const systemPrompt = systemPromptParts.join("\n\n");

    /*
    FNXC:OmpAcp 2026-07-13-22:50 / 2026-07-14-00:05:
    Fusion system/runtime context + tool rules reach omp via session/new._meta
    systemPromptOverride (same contract as Grok ACP).
    */
    const sessionMeta: Record<string, unknown> = {
      ...(options.sessionMeta ?? {}),
      ...(systemPrompt ? { systemPromptOverride: systemPrompt } : {}),
      ...(toolBridge ? { fusionToolCount: toolBridge.toolCount } : {}),
    };

    const sessionOptions: AgentRuntimeOptions = {
      ...options,
      cwd: options.cwd?.trim() ? options.cwd : process.cwd(),
      systemPrompt,
      defaultModelId: modelForCli(model) ?? model,
      mcpServers,
      sessionMeta,
      onText: (delta: string) => {
        turnAccum.text += delta;
        options.onText?.(delta);
      },
      onThinking: (delta: string) => {
        options.onThinking?.(delta);
      },
      onToolStart: (name: string, args?: unknown) => {
        options.onToolStart?.(name, args);
      },
      onToolEnd: (name: string, isError: boolean, result?: unknown) => {
        options.onToolEnd?.(name, isError, result);
      },
    };

    const settings = buildOmpAcpRuntimeSettings({
      binary: this.binary,
      model,
    });
    const acp = this.createAcpAdapter(settings);

    try {
      const result = await acp.createSession(sessionOptions);
      /*
      FNXC:OmpAcp 2026-07-13-23:10:
      Prefer sessionOptions (turnAccum-wrapped callbacks) over the raw engine options when
      ACP returns empty callbacks — otherwise assistant text is not accumulated for history.
      */
      const session = ensureOmpSessionShape(
        result.session,
        model,
        sessionOptions,
        turnAccum,
        resources,
      );
      this.adapters.set(session, acp);
      return { session, sessionFile: result.sessionFile };
    } catch (error) {
      const diagnostic = describeCreateFailure(error);
      const session = createDeadSession(model, sessionOptions, diagnostic, resources);
      session.callbacks.onText?.(diagnostic);
      appendMessage(session, "assistant", diagnostic);
      return { session, sessionFile: undefined };
    }
  }

  async promptWithFallback(
    session: AgentSession,
    prompt: string,
    options?: unknown,
  ): Promise<void | { stopReason?: string }> {
    const ompSession = session as OmpSession;
    appendMessage(ompSession, "user", prompt);
    resetTurnAccum(ompSession);

    const acp = this.adapters.get(session);
    const hasConnection =
      acp && "connection" in session && Boolean((session as { connection?: unknown }).connection);

    /*
    FNXC:OmpAcp 2026-07-11-23:35:
    Dead / disposed sessions have no ACP connection. Follow-up prompts must not
    append a user message and return silently — always re-surface a diagnostic
    via onText + assistant message so multi-turn chat stays visible.
    */
    if (!hasConnection) {
      const existing = ompSession.state.errorMessage?.trim();
      const diagnostic = existing
        ? `OMP ACP session has no live connection (previous error: ${existing}). Start a new session to retry.`
        : "OMP ACP session has no live connection. The `omp acp` process failed to start or was disposed.";
      ompSession.state.errorMessage = diagnostic;
      ompSession.callbacks.onText?.(diagnostic);
      appendMessage(ompSession, "assistant", diagnostic);
      return;
    }

    try {
      const result = await acp!.promptWithFallback(session, prompt, options);
      const assistantText = getTurnAccum(ompSession).text;
      if (assistantText.length > 0) {
        appendMessage(ompSession, "assistant", assistantText);
      } else if (result && typeof result === "object" && "stopReason" in result) {
        const stopReason = result.stopReason;
        if (stopReason && stopReason !== "end_turn" && stopReason !== "EndTurn") {
          const diagnostic = `OMP ACP ended with stopReason ${stopReason} and produced no assistant text.`;
          ompSession.state.errorMessage = diagnostic;
          ompSession.callbacks.onText?.(diagnostic);
          appendMessage(ompSession, "assistant", diagnostic);
        }
      }
      return result;
    } catch (error) {
      const assistantText = getTurnAccum(ompSession).text;
      if (assistantText.length === 0) {
        const diagnostic = describePromptFailure(error);
        ompSession.state.errorMessage = diagnostic;
        ompSession.callbacks.onText?.(diagnostic);
        appendMessage(ompSession, "assistant", diagnostic);
      } else {
        appendMessage(ompSession, "assistant", assistantText);
      }
      return;
    }
  }

  describeModel(session: AgentSession): string {
    const ompSession = session as OmpSession;
    return ompSession.lastModelDescription || `omp/${ompSession.model ?? "default"}`;
  }

  async dispose(session: AgentSession): Promise<void> {
    const resources = (session as SessionWithExtras)[SESSION_RESOURCES];
    try {
      await resources?.toolBridge?.dispose();
    } catch {
      // best-effort
    }
    const acp = this.adapters.get(session);
    if (acp && typeof acp.dispose === "function") {
      await acp.dispose(session);
      return;
    }
    const omp = session as OmpSession;
    omp.dispose?.();
  }
}
