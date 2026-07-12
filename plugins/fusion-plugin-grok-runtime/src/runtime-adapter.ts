import { AcpRuntimeAdapter } from "./acp/index.js";
import {
  buildGrokAcpRuntimeSettings,
  modelForCli,
  normalizeGrokCliModel,
} from "./acp-settings.js";
import { toAcpMcpServers, type AcpMcpServer } from "./mcp-forwarding.js";
import {
  buildGrokSkillRules,
  extractRequestedSkillNames,
  stageGrokSessionSkills,
} from "./skill-loader.js";
import { startFusionToolBridge, type FusionToolBridge, type ToolLike } from "./tool-bridge.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  AgentSession,
  AgentSessionResult,
  GrokSession,
} from "./types.js";

/*
FNXC:GrokAcp 2026-07-11-12:00:
Replace the one-shot headless path (`grok -p --output-format json`) with native
ACP transport (`grok agent stdio`) for realtime streaming, tool visibility, and
multi-turn session reuse. Implementation composes a vendored AcpRuntimeAdapter
(copied under ./acp/, not imported from fusion-plugin-acp-runtime) with
Grok-specific binary/args/env. Keep resolve-never-reject on prompt failures so
chat/executor always get a well-formed turn; surface create/prompt failures as
visible onText diagnostics rather than silent empty bubbles (FN-7779 invariant).

FNXC:GrokAcp 2026-07-11-16:00:
Do not import `@fusion-plugin-examples/acp-runtime`. Grok is bundled/auto-install;
the generic ACP plugin is experimental. Vendor the client modules under src/acp/.

FNXC:GrokCliRouting 2026-07-10-10:54:
FN-7753's auto-derived `grok` runtime routing from a `grok-cli/*` model selection
still preserves the concrete model. Normalize provider-qualified ids
(`grok-cli/<id>` or `grok/<id>`) and pass only the concrete id as `grok agent -m`;
the no-model Runtime-mode path keeps `grok/default` and omits `-m`.

FNXC:GrokAcp 2026-07-11-14:00:
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

export interface GrokRuntimeAdapterOptions {
  /** Binary name/path to invoke. Defaults to "grok" (PATH resolution). */
  binary?: string;
  /**
   * Injectable ACP adapter factory for tests. Production uses
   * `AcpRuntimeAdapter` with Grok ACP settings.
   */
  createAcpAdapter?: AcpAdapterFactory;
}

/** Turn-scoped stream accumulators stored on the session for prompt finalization. */
interface TurnAccum {
  text: string;
}

interface SessionResources {
  toolBridge?: FusionToolBridge | null;
  skillStaging?: { dispose: () => void } | null;
}

function compactDiagnostic(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function describeCreateFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(
    `Grok ACP failed to start: ${reason}. Ensure the \`grok\` binary is installed and authenticated (` +
      `\`grok agent stdio\`), or set XAI_API_KEY / GROK_API_KEY for key-based auth.`,
  );
}

function describePromptFailure(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error ?? "unknown error");
  return compactDiagnostic(`Grok ACP turn failed: ${reason}`);
}

function appendMessage(session: GrokSession, role: "user" | "assistant", content: string): void {
  const entry = { role, content };
  session.state.messages.push(entry);
  if (session.messages !== session.state.messages) {
    session.messages.push(entry);
  }
}

const TURN_ACCUM = Symbol("grokTurnAccum");
const SESSION_RESOURCES = Symbol("grokSessionResources");

type SessionWithExtras = GrokSession & {
  [TURN_ACCUM]?: TurnAccum;
  [SESSION_RESOURCES]?: SessionResources;
};

function getTurnAccum(session: GrokSession): TurnAccum {
  const s = session as SessionWithExtras;
  if (!s[TURN_ACCUM]) {
    s[TURN_ACCUM] = { text: "" };
  }
  return s[TURN_ACCUM];
}

function resetTurnAccum(session: GrokSession): void {
  getTurnAccum(session).text = "";
}

function collectCustomTools(options: AgentRuntimeOptions): ToolLike[] {
  const fromCustom = Array.isArray(options.customTools) ? (options.customTools as ToolLike[]) : [];
  /*
  FNXC:GrokAcp 2026-07-11-19:00:
  AgentRuntimeOptions.tools is typed as "coding"|"readonly"|undefined, but some call sites pass
  an array of ToolDefinitions. Narrow via Array.isArray on the tools field, then cast the array
  value only — never cast the whole options object to { tools: ToolLike[] } (TS2352).
  */
  const toolsField = (options as { tools?: unknown }).tools;
  const maybeToolsArray = Array.isArray(toolsField) ? (toolsField as ToolLike[]) : [];
  return [...fromCustom, ...maybeToolsArray];
}

function ensureGrokSessionShape(
  session: AgentSession,
  model: string,
  options: AgentRuntimeOptions,
  turnAccum: TurnAccum,
  resources: SessionResources,
): GrokSession {
  const messages: unknown[] =
    Array.isArray((session as GrokSession).messages) ? (session as GrokSession).messages : [];
  const existingState = (session as { state?: GrokSession["state"] }).state;
  const state: GrokSession["state"] = existingState ?? { messages };
  if (!Array.isArray(state.messages)) {
    state.messages = messages;
  }

  const grok = session as GrokSession;
  grok.model = model;
  grok.systemPrompt = grok.systemPrompt ?? options.systemPrompt;
  grok.messages = state.messages;
  grok.state = state;
  grok.lastModelDescription = `grok/${model}`;
  // Prefer callbacks already installed on the ACP session (wrapped at create
  // for turnAccum + engine fans-out). Only fall back to the raw engine options.
  grok.callbacks = {
    onText: grok.callbacks?.onText ?? options.onText,
    onThinking: grok.callbacks?.onThinking ?? options.onThinking,
    onToolStart: grok.callbacks?.onToolStart ?? options.onToolStart,
    onToolEnd: grok.callbacks?.onToolEnd ?? options.onToolEnd,
  };

  const originalDispose = typeof grok.dispose === "function" ? grok.dispose.bind(grok) : () => undefined;
  grok.dispose = () => {
    void resources.toolBridge?.dispose();
    resources.skillStaging?.dispose();
    originalDispose();
  };

  (grok as SessionWithExtras)[TURN_ACCUM] = turnAccum;
  (grok as SessionWithExtras)[SESSION_RESOURCES] = resources;
  return grok;
}

function createDeadSession(
  model: string,
  options: AgentRuntimeOptions,
  diagnostic: string,
  resources?: SessionResources,
): GrokSession {
  const messages: unknown[] = [];
  const session: GrokSession = {
    model,
    systemPrompt: options.systemPrompt,
    messages,
    state: { messages, errorMessage: diagnostic },
    sessionId: undefined,
    lastModelDescription: `grok/${model}`,
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

export class GrokRuntimeAdapter implements AgentRuntime {
  readonly id = "grok";
  readonly name = "Grok Runtime";
  private readonly binary: string;
  private readonly createAcpAdapter: AcpAdapterFactory;
  /** Per-session ACP adapter so model-specific spawn args stay consistent. */
  private readonly adapters = new WeakMap<object, ReturnType<AcpAdapterFactory>>();

  constructor(options?: GrokRuntimeAdapterOptions) {
    this.binary = options?.binary ?? "grok";
    /*
    FNXC:GrokAcp 2026-07-11-19:00:
    AcpRuntimeAdapter returns ACP AgentSession shapes (acp/types); AcpAdapterFactory is typed
    against Grok AgentSessionResult (messages/state). createSession always runs
    ensureGrokSessionShape after the ACP create, so the production factory is a deliberate
    structural bridge via unknown rather than unifying the two session interfaces here.
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
    const model = normalizeGrokCliModel(options.defaultModelId) ?? "grok/default";
    const turnAccum: TurnAccum = { text: "" };
    const resources: SessionResources = {};

    // ── Skills ────────────────────────────────────────────────────────────
    const requestedSkillNames = extractRequestedSkillNames({
      skills: options.skills,
      skillSelection: options.skillSelection,
    });
    const skillStaging = stageGrokSessionSkills({
      requestedSkillNames,
      additionalSkillPaths: options.additionalSkillPaths,
      includeFusionSkill: true,
    });
    resources.skillStaging = skillStaging;

    // ── Operator MCP + Fusion custom tools ────────────────────────────────
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

    const rules = buildGrokSkillRules({
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

    const settings = buildGrokAcpRuntimeSettings({
      binary: this.binary,
      model,
      pluginDirs: [skillStaging.pluginDir],
    });
    const acp = this.createAcpAdapter(settings);

    try {
      const result = await acp.createSession(sessionOptions);
      const session = ensureGrokSessionShape(result.session, model, options, turnAccum, resources);
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
    const grokSession = session as GrokSession;
    appendMessage(grokSession, "user", prompt);
    resetTurnAccum(grokSession);

    const acp = this.adapters.get(session);
    const hasConnection =
      acp && "connection" in session && Boolean((session as { connection?: unknown }).connection);

    if (!hasConnection) {
      const existing = grokSession.state.errorMessage?.trim();
      if (existing) {
        return;
      }
      const diagnostic =
        "Grok ACP session has no live connection. The `grok agent stdio` process failed to start or was disposed.";
      grokSession.state.errorMessage = diagnostic;
      grokSession.callbacks.onText?.(diagnostic);
      appendMessage(grokSession, "assistant", diagnostic);
      return;
    }

    try {
      const result = await acp!.promptWithFallback(session, prompt, options);
      const assistantText = getTurnAccum(grokSession).text;
      if (assistantText.length > 0) {
        appendMessage(grokSession, "assistant", assistantText);
      } else if (result && typeof result === "object" && "stopReason" in result) {
        const stopReason = result.stopReason;
        if (stopReason && stopReason !== "end_turn" && stopReason !== "EndTurn") {
          const diagnostic = `Grok ACP ended with stopReason ${stopReason} and produced no assistant text.`;
          grokSession.state.errorMessage = diagnostic;
          grokSession.callbacks.onText?.(diagnostic);
          appendMessage(grokSession, "assistant", diagnostic);
        }
      }
      return result;
    } catch (error) {
      const assistantText = getTurnAccum(grokSession).text;
      if (assistantText.length === 0) {
        const diagnostic = describePromptFailure(error);
        grokSession.state.errorMessage = diagnostic;
        grokSession.callbacks.onText?.(diagnostic);
        appendMessage(grokSession, "assistant", diagnostic);
      } else {
        appendMessage(grokSession, "assistant", assistantText);
      }
      return;
    }
  }

  describeModel(session: AgentSession): string {
    const grokSession = session as GrokSession;
    return grokSession.lastModelDescription || `grok/${grokSession.model ?? "default"}`;
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
    const grok = session as GrokSession;
    grok.dispose?.();
  }
}
