/*
FNXC:GrokCli 2026-07-10-12:50:
FN-7796: xAI Grok Build TUI's `--output-format streaming-json` can emit reasoning-only events and then `stopReason:"Cancelled"` with zero assistant text. The primary headless contract is therefore the reliable single `--output-format json` object `{text,stopReason,sessionId,requestId,thought}`; streaming event types remain only for diagnostics/regressions that model the captured flaky shape.
*/

export interface GrokCliJsonResponse {
  text?: string;
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
  thought?: string;
}


export interface GrokThoughtEvent {
  type: "thought";
  data: string;
}

export interface GrokTextEvent {
  type: "text";
  data: string;
}

export interface GrokEndEvent {
  type: "end";
  stopReason?: string;
  sessionId?: string;
  requestId?: string;
}

export type GrokNdjsonEvent = GrokThoughtEvent | GrokTextEvent | GrokEndEvent;

export interface GrokCallbacks {
  /** Streams real assistant text from xAI Grok Build TUI `text.data` events. */
  onText?: (text: string) => void;
  /** Streams reasoning/thinking text from xAI Grok Build TUI `thought.data` events. */
  onThinking?: (text: string) => void;
  /** Kept for AgentRuntime interface parity; xAI `streaming-json` has no observed tool-use event. */
  onToolStart?: (toolName: string, args?: unknown) => void;
  /** Kept for AgentRuntime interface parity; xAI `streaming-json` has no observed tool-use event. */
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
}

export interface GrokSession {
  model: string;
  systemPrompt?: string;
  messages: unknown[];
  state: { errorMessage?: string; messages: unknown[] };
  sessionId?: string;
  lastModelDescription: string;
  callbacks: GrokCallbacks;
}

export type AgentSession = GrokSession;

export interface AgentRuntimeOptions {
  cwd?: string;
  systemPrompt?: string;
  defaultModelId?: string;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  signal?: AbortSignal;
}

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
  dispose?(session: AgentSession): Promise<void>;
}

export interface GrokBinaryStatus {
  available: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: means "Grok CLI runtime ready" (the `grok` binary is available
   * on PATH or at a configured path) — NOT "a Fusion-visible API key was
   * found". The `grok` CLI owns its own authentication (env var, project
   * `.env`, `grok -k`, etc.); Fusion no longer requires visibility into a
   * key to treat the provider as authenticated. See `apiKeyDetected` for the
   * non-blocking informational key-presence signal.
   */
  authenticated?: boolean;
  /**
   * FNXC:GrokCli 2026-07-09-00:00:
   * FN-7716: non-blocking informational hint only — true when Fusion itself
   * detected a Grok API key (GROK_API_KEY env var or
   * ~/.grok/user-settings.json `apiKey`). Never gates `authenticated` or
   * enable/disable; the direct xAI OpenAI-compatible streaming path
   * (FN-7711/FN-7714) uses $GROK_API_KEY when present regardless of this CLI
   * probe.
   */
  apiKeyDetected?: boolean;
  binaryPath?: string;
  binaryName?: string;
  configuredBinaryPath?: string;
  usingConfiguredBinaryPath?: boolean;
  diagnostics?: string[];
  version?: string;
  reason?: string;
  probeDurationMs: number;
}
