import { AcpRuntimeAdapter } from "./acp/index.js";
import {
  buildOmpAcpRuntimeSettings,
  modelForCli,
  normalizeOmpCliModel,
} from "./acp-settings.js";
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

const TURN_ACCUM = Symbol("ompTurnAccum");

type SessionWithExtras = OmpSession & {
  [TURN_ACCUM]?: TurnAccum;
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

function ensureOmpSessionShape(
  session: AgentSession,
  model: string,
  options: AgentRuntimeOptions,
  turnAccum: TurnAccum,
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

  (omp as SessionWithExtras)[TURN_ACCUM] = turnAccum;
  return omp;
}

function createDeadSession(
  model: string,
  options: AgentRuntimeOptions,
  diagnostic: string,
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
    dispose: () => undefined,
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
    const model = normalizeOmpCliModel(options.defaultModelId) ?? "omp/default";
    const turnAccum: TurnAccum = { text: "" };

    const systemPrompt = options.systemPrompt?.trim() ?? "";
    /*
    FNXC:OmpAcp 2026-07-13-22:50:
    Fusion system/runtime context must reach omp. ACP session/new._meta carries
    systemPromptOverride (same contract as Grok ACP); without it only user turns
    were sent and omp kept its default system prompt.
    */
    const sessionMeta: Record<string, unknown> = {
      ...(options.sessionMeta ?? {}),
      ...(systemPrompt ? { systemPromptOverride: systemPrompt } : {}),
    };
    const sessionOptions: AgentRuntimeOptions = {
      ...options,
      cwd: options.cwd?.trim() ? options.cwd : process.cwd(),
      systemPrompt,
      defaultModelId: modelForCli(model) ?? model,
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
      const session = ensureOmpSessionShape(result.session, model, options, turnAccum);
      this.adapters.set(session, acp);
      return { session, sessionFile: result.sessionFile };
    } catch (error) {
      const diagnostic = describeCreateFailure(error);
      const session = createDeadSession(model, sessionOptions, diagnostic);
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
    const acp = this.adapters.get(session);
    if (acp && typeof acp.dispose === "function") {
      await acp.dispose(session);
      return;
    }
    const omp = session as OmpSession;
    omp.dispose?.();
  }
}
