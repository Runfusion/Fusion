import { AcpRuntimeAdapter } from "./acp/index.js";
import {
  buildClaudeAcpRuntimeSettings,
  modelForCli,
  normalizeClaudeCliModel,
} from "./acp-settings.js";
import { toAcpMcpServers, type AcpMcpServer } from "./mcp-forwarding.js";
import {
  buildClaudeSkillRules,
  extractRequestedSkillNames,
  stageClaudeSessionSkills,
} from "./skill-loader.js";
import { startFusionToolBridge, type FusionToolBridge, type ToolLike } from "./tool-bridge.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  ClaudeSession,
} from "./types.js";

/*
FNXC:ClaudeAcp 2026-07-11-12:00:
Replace the one-shot headless path (`claude -p --output-format json`) with native
ACP transport (`claude agent stdio`) for realtime streaming, tool visibility, and
multi-turn session reuse. Implementation composes a vendored AcpRuntimeAdapter
(copied under ./acp/, not imported from fusion-plugin-acp-runtime) with
Claude-specific binary/args/env. Keep resolve-never-reject on prompt failures so
chat/executor always get a well-formed turn; surface create/prompt failures as
visible onText diagnostics rather than silent empty bubbles (FN-7779 invariant).

FNXC:ClaudeAcp 2026-07-11-16:00:
Do not import `@fusion-plugin-examples/acp-runtime`. Claude is bundled/auto-install;
the generic ACP plugin is experimental. Vendor the client modules under src/acp/.

FNXC:ClaudeCliRouting 2026-07-10-10:54:
FN-7753's auto-derived `claude` runtime routing from a `claude-cli/*` model selection
still preserves the concrete model. Normalize provider-qualified ids
(`claude-cli/<id>` or `claude/<id>`) and pass only the concrete id as `claude agent -m`;
the no-model Runtime-mode path keeps `claude/default` and omits `-m`.

FNXC:ClaudeAcp 2026-07-11-14:00:
Load Fusion tools + skills into the ACP session:
  - Operator MCP servers → session/new.mcpServers (stdio/http/sse)
  - Engine customTools (fn_*) → loopback MCP bridge + fusion-custom-tools server
  - Skills → session-scoped --plugin-dir / _meta.pluginDirs + rules context
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

export interface ClaudeRuntimeAdapterOptions {
  /** Binary name/path to invoke. Defaults to "claude" (PATH resolution). */
  binary?: string;
  /**
   * Injectable ACP adapter factory for tests. Production uses
   * `AcpRuntimeAdapter` with Claude ACP settings.
   */
  createAcpAdapter?: AcpAdapterFactory;
  /** Injectable only to assert bridge failure handling without binding a port. */
  startToolBridge?: typeof startFusionToolBridge;
}

/** Turn-scoped stream accumulators stored on the session for prompt finalization. */
interface TurnAccum {
  text: string;
}

interface SessionResources {
  toolBridge?: FusionToolBridge | null;
  toolBridgeFailure?: "mcp-schema-server-missing" | "bridge-start-failed";
  skillStaging?: { dispose: () => void } | null;
}

function bridgeFailureReasonCode(error: unknown): "mcp-schema-server-missing" | "bridge-start-failed" {
  return (error as { code?: unknown })?.code === "mcp-schema-server-missing"
    ? "mcp-schema-server-missing"
    : "bridge-start-failed";
}

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeCreateFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(
    `Claude ACP failed to start: ${reason}. Ensure the \`claude\` binary is installed and authenticated (` +
      `\`claude agent stdio\`), or set XAI_API_KEY / GROK_API_KEY for key-based auth.`,
  );
}

/*
FNXC:ClaudeAcp 2026-07-15-18:45:
`promptAcpSession` (acp-runtime provider.ts) already re-shapes JSON-RPC faults into a diagnostic
carrying the rpc code — e.g. `Internal error (acp rpc code -32603, retryable)`. Pass that through
verbatim rather than re-flattening to `error.message`, so the engine's transient classifier can
recognize a provider-side blip and retry instead of parking the task permanently.

FN-8004: the bare message reaching the merger was "Internal error", matched no transient pattern,
and terminally failed an auto-merge whose branch work was complete and correct.
*/
function describePromptFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(`Claude ACP turn failed: ${reason}`);
}

function appendMessage(session: ClaudeSession, role: "user" | "assistant", content: string): void {
  const entry = { role, content };
  session.state.messages.push(entry);
  if (session.messages !== session.state.messages) {
    session.messages.push(entry);
  }
}

const TURN_ACCUM = Symbol("claudeTurnAccum");
const SESSION_RESOURCES = Symbol("claudeSessionResources");

type SessionWithExtras = ClaudeSession & {
  [TURN_ACCUM]?: TurnAccum;
  [SESSION_RESOURCES]?: SessionResources;
};

function getTurnAccum(session: ClaudeSession): TurnAccum {
  const s = session as SessionWithExtras;
  if (!s[TURN_ACCUM]) {
    s[TURN_ACCUM] = { text: "" };
  }
  return s[TURN_ACCUM];
}

function resetTurnAccum(session: ClaudeSession): void {
  getTurnAccum(session).text = "";
}

function collectCustomTools(options: AgentRuntimeOptions): ToolLike[] {
  const fromCustom = Array.isArray(options.customTools) ? (options.customTools as ToolLike[]) : [];
  /*
  FNXC:ClaudeAcp 2026-07-11-19:00:
  AgentRuntimeOptions.tools is typed as "coding"|"readonly"|undefined, but some call sites pass
  an array of ToolDefinitions. Narrow via Array.isArray on the tools field, then cast the array
  value only — never cast the whole options object to { tools: ToolLike[] } (TS2352).
  */
  const toolsField = (options as { tools?: unknown }).tools;
  const maybeToolsArray = Array.isArray(toolsField) ? (toolsField as ToolLike[]) : [];
  return [...fromCustom, ...maybeToolsArray];
}

function ensureClaudeSessionShape(
  session: AgentSession,
  model: string,
  options: AgentRuntimeOptions,
  turnAccum: TurnAccum,
  resources: SessionResources,
): ClaudeSession {
  const messages: unknown[] =
    Array.isArray((session as ClaudeSession).messages) ? (session as ClaudeSession).messages : [];
  const existingState = (session as { state?: ClaudeSession["state"] }).state;
  const state: ClaudeSession["state"] = existingState ?? { messages };
  if (!Array.isArray(state.messages)) {
    state.messages = messages;
  }

  const claude = session as ClaudeSession;
  claude.model = model;
  claude.systemPrompt = claude.systemPrompt ?? options.systemPrompt;
  claude.messages = state.messages;
  claude.state = state;
  claude.lastModelDescription = `claude/${model}`;
  if (resources.toolBridgeFailure) {
    claude.fusionToolBridgeError = { reasonCode: resources.toolBridgeFailure };
  }
  // Prefer callbacks already installed on the ACP session (wrapped at create
  // for turnAccum + engine fans-out). Only fall back to the raw engine options.
  claude.callbacks = {
    onText: claude.callbacks?.onText ?? options.onText,
    onThinking: claude.callbacks?.onThinking ?? options.onThinking,
    onToolStart: claude.callbacks?.onToolStart ?? options.onToolStart,
    onToolEnd: claude.callbacks?.onToolEnd ?? options.onToolEnd,
  };

  const originalDispose = typeof claude.dispose === "function" ? claude.dispose.bind(claude) : () => undefined;
  claude.dispose = () => {
    void resources.toolBridge?.dispose();
    resources.skillStaging?.dispose();
    originalDispose();
  };

  (claude as SessionWithExtras)[TURN_ACCUM] = turnAccum;
  (claude as SessionWithExtras)[SESSION_RESOURCES] = resources;
  return claude;
}

function createDeadSession(
  model: string,
  options: AgentRuntimeOptions,
  diagnostic: string,
  resources?: SessionResources,
): ClaudeSession {
  const messages: unknown[] = [];
  const session: ClaudeSession = {
    model,
    systemPrompt: options.systemPrompt,
    messages,
    state: { messages, errorMessage: diagnostic },
    sessionId: undefined,
    lastModelDescription: `claude/${model}`,
    callbacks: {
      onText: options.onText,
      onThinking: options.onThinking,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
    },
    dispose: () => {
      void resources?.toolBridge?.dispose();
      resources?.skillStaging?.dispose();
    },
  };
  return session;
}

export class ClaudeRuntimeAdapter implements AgentRuntime {
  readonly id = "claude";
  readonly name = "Claude Runtime";
  private readonly binary?: string;
  private readonly createAcpAdapter: AcpAdapterFactory;
  private readonly startToolBridge: typeof startFusionToolBridge;
  /** Per-session ACP adapter so model-specific spawn args stay consistent. */
  private readonly adapters = new WeakMap<object, ReturnType<AcpAdapterFactory>>();

  constructor(options?: ClaudeRuntimeAdapterOptions) {
    // The default is the staged, identity-pinned Claude ACP bridge; injection is test-only.
    this.binary = options?.binary;
    /*
    FNXC:ClaudeAcp 2026-07-11-19:00:
    AcpRuntimeAdapter returns ACP AgentSession shapes (acp/types); AcpAdapterFactory is typed
    against Claude AgentSessionResult (messages/state). createSession always runs
    ensureClaudeSessionShape after the ACP create, so the production factory is a deliberate
    structural bridge via unknown rather than unifying the two session interfaces here.
    */
    this.createAcpAdapter =
      options?.createAcpAdapter ??
      ((settings) => new AcpRuntimeAdapter(settings) as unknown as ReturnType<AcpAdapterFactory>);
    this.startToolBridge = options?.startToolBridge ?? startFusionToolBridge;
  }

  async createSession(
    options: AgentRuntimeOptions = {
      cwd: process.cwd(),
      systemPrompt: "",
    },
  ): Promise<AgentSessionResult> {
    const model = normalizeClaudeCliModel(options.defaultModelId) ?? "claude/default";
    const turnAccum: TurnAccum = { text: "" };
    const resources: SessionResources = {};

    // ── Skills ────────────────────────────────────────────────────────────
    const requestedSkillNames = extractRequestedSkillNames({
      skills: options.skills,
      skillSelection: options.skillSelection,
    });
    const skillStaging = stageClaudeSessionSkills({
      requestedSkillNames,
      additionalSkillPaths: options.additionalSkillPaths,
      includeFusionSkill: true,
    });
    resources.skillStaging = skillStaging;

    // ── Operator MCP + Fusion custom tools ────────────────────────────────
    const operatorMcp = toAcpMcpServers(options.mcpServers);
    const customTools = collectCustomTools(options);
    let toolBridge: FusionToolBridge | null = null;
    try {
      toolBridge = await this.startToolBridge(customTools, {
        actionGateContext: options.actionGateContext,
      });
      resources.toolBridge = toolBridge;
    } catch (error) {
      toolBridge = null;
      if (customTools.length > 0) {
        const reasonCode = bridgeFailureReasonCode(error);
        resources.toolBridgeFailure = reasonCode;
        /*
        FNXC:FusionToolBridgeDiagnostics 2026-07-20-08:00:
        Requested fn_* tools must never silently degrade when their MCP bridge fails.
        Emit a stable, schema-free diagnostic and preserve only its fixed reason code
        on the session so engine audit metadata stays ids/counts/outcomes-only.
        */
        options.onText?.(`FUSION_TOOL_BRIDGE_FAILED: ${reasonCode}`);
      }
    }

    const mcpServers: AcpMcpServer[] = [
      ...operatorMcp,
      ...(toolBridge ? [toolBridge.mcpServer] : []),
    ];

    const rules = buildClaudeSkillRules({
      skillNames: skillStaging.skillNames.length > 0 ? skillStaging.skillNames : requestedSkillNames,
      toolMode: typeof options.tools === "string" ? options.tools : "coding",
      fusionToolCount: toolBridge?.toolCount,
      operatorMcpCount: operatorMcp.length,
    });

    const systemPromptParts = [options.systemPrompt?.trim() ?? "", rules].filter((part) => part.length > 0);
    const systemPrompt = systemPromptParts.join("\n\n");

    const sessionMeta: Record<string, unknown> = {
      pluginDirs: [skillStaging.pluginDir],
      rules,
      ...(systemPrompt ? { systemPromptOverride: systemPrompt } : {}),
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

    const settings = buildClaudeAcpRuntimeSettings({
      ...(this.binary ? { binary: this.binary } : {}),
      model,
      pluginDirs: [skillStaging.pluginDir],
    });
    const acp = this.createAcpAdapter(settings);

    try {
      const result = await acp.createSession(sessionOptions);
      const session = ensureClaudeSessionShape(result.session, model, options, turnAccum, resources);
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
    const claudeSession = session as ClaudeSession;
    appendMessage(claudeSession, "user", prompt);
    resetTurnAccum(claudeSession);

    const acp = this.adapters.get(session);
    const hasConnection =
      acp && "connection" in session && Boolean((session as { connection?: unknown }).connection);

    /*
    FNXC:ClaudeAcp 2026-07-12-06:15:
    Dead / disposed sessions have no ACP connection. Follow-up prompts must not
    append a user message and return silently — always re-surface a diagnostic
    via onText + assistant message so multi-turn chat stays visible. Prefer the
    previous errorMessage when present so operators still see the root cause.
    */
    if (!hasConnection) {
      const existing = claudeSession.state.errorMessage?.trim();
      const diagnostic = existing
        ? `Claude ACP session has no live connection (previous error: ${existing}). Start a new session to retry.`
        : "Claude ACP session has no live connection. The `claude agent stdio` process failed to start or was disposed.";
      claudeSession.state.errorMessage = diagnostic;
      claudeSession.callbacks.onText?.(diagnostic);
      appendMessage(claudeSession, "assistant", diagnostic);
      return;
    }

    try {
      const result = await acp!.promptWithFallback(session, prompt, options);
      const assistantText = getTurnAccum(claudeSession).text;
      if (assistantText.length > 0) {
        appendMessage(claudeSession, "assistant", assistantText);
      } else if (result && typeof result === "object" && "stopReason" in result) {
        const stopReason = result.stopReason;
        if (stopReason && stopReason !== "end_turn" && stopReason !== "EndTurn") {
          const diagnostic = `Claude ACP ended with stopReason ${stopReason} and produced no assistant text.`;
          claudeSession.state.errorMessage = diagnostic;
          claudeSession.callbacks.onText?.(diagnostic);
          appendMessage(claudeSession, "assistant", diagnostic);
        }
      }
      return result;
    } catch (error) {
      const assistantText = getTurnAccum(claudeSession).text;
      if (assistantText.length === 0) {
        const diagnostic = describePromptFailure(error);
        claudeSession.state.errorMessage = diagnostic;
        claudeSession.callbacks.onText?.(diagnostic);
        appendMessage(claudeSession, "assistant", diagnostic);
      } else {
        appendMessage(claudeSession, "assistant", assistantText);
      }
      return;
    }
  }

  describeModel(session: AgentSession): string {
    const claudeSession = session as ClaudeSession;
    return claudeSession.lastModelDescription || `claude/${claudeSession.model ?? "default"}`;
  }

  async dispose(session: AgentSession): Promise<void> {
    const resources = (session as SessionWithExtras)[SESSION_RESOURCES];
    try {
      await resources?.toolBridge?.dispose();
    } catch {
      // best-effort
    }
    try {
      resources?.skillStaging?.dispose();
    } catch {
      // best-effort
    }
    const acp = this.adapters.get(session);
    if (acp && typeof acp.dispose === "function") {
      await acp.dispose(session);
      return;
    }
    const claude = session as ClaudeSession;
    claude.dispose?.();
  }
}
