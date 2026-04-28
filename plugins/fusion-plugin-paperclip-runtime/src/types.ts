/**
 * Paperclip Runtime Plugin - Local runtime interface types.
 */

export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: unknown;
  customTools?: unknown;
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  fallbackProvider?: string;
  fallbackModelId?: string;
  defaultThinkingLevel?: string;
  sessionManager?: unknown;
  skillSelection?: unknown;
  skills?: string[];
}

export type PaperclipMode = "issue-per-prompt" | "rolling-issue" | "wakeup-only";

/**
 * How the adapter authenticates to Paperclip.
 *
 *   - `"api"` (default): caller provides apiUrl + apiKey explicitly. Suitable
 *     for cloud installs or when you want to bypass the local CLI.
 *   - `"cli"`: derive the apiUrl (and, if available, apiKey) from a local
 *     `paperclipai` install. Reads `~/.paperclip/instances/default/config.json`
 *     to get host:port; for local-trusted deployments no key is required.
 */
export type PaperclipTransport = "api" | "cli";

export interface PaperclipSession {
  apiUrl: string;
  apiKey: string | undefined;
  /** Resolved at session-create time (auto-derived from /agents/me if not configured). */
  agentId: string;
  /** Resolved at session-create time (auto-derived from /agents/me if not configured). */
  companyId: string;
  /** Logical Fusion session id; used as the basis for idempotency keys. */
  sessionId: string;
  systemPrompt: string;
  cwd: string;
  mode: PaperclipMode;
  /** Optional issue scoping passed at create time. */
  parentIssueId?: string;
  projectId?: string;
  goalId?: string;
  /** Set by the adapter on first prompt in `rolling-issue` mode; reused thereafter. */
  issueId?: string;
  /**
   * Resolved transport for this session — copied from the runtime config so
   * `promptWithFallback` can route createIssue/getIssue through `paperclipai`
   * when the user picked the Local CLI tab in settings.
   */
  transport: PaperclipTransport;
  /** Optional override for the paperclipai binary; used when transport=cli. */
  cliBinaryPath?: string;
  /** Optional override for the paperclipai instance config path. */
  cliConfigPath?: string;
  /** Incremented per prompt. Combined with sessionId to form an idempotency key. */
  turnIndex: number;
  /** Hard cap for a single wakeup-run polling loop. */
  runTimeoutMs: number;
  pollIntervalMs: number;
  pollIntervalMaxMs: number;
  onText: ((text: string) => void) | undefined;
  onThinking: ((text: string) => void) | undefined;
  onToolStart: ((toolName: string, args?: unknown) => void) | undefined;
  onToolEnd: ((toolName: string, isError: boolean, result?: unknown) => void) | undefined;
  dispose?: () => void;
}

export interface AgentSessionResult {
  session: PaperclipSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  id: string;
  name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: PaperclipSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: PaperclipSession): string;
  dispose?(session: PaperclipSession): Promise<void>;
}

export interface PaperclipRuntimeConfig {
  apiUrl: string;
  apiKey?: string;
  agentId?: string;
  companyId?: string;
  mode?: PaperclipMode;
  /**
   * Auth/discovery transport. Default `"api"`.
   * When `"cli"`, the adapter spawns `paperclipai` (or reads its config) to
   * derive apiUrl/apiKey at session-create time.
   */
  transport?: PaperclipTransport;
  /** Path to the `paperclipai` binary when transport=cli. Default `"paperclipai"`. */
  cliBinaryPath?: string;
  /**
   * Path to the paperclipai instance config file. Default
   * `~/.paperclip/instances/default/config.json`.
   */
  cliConfigPath?: string;
  parentIssueId?: string;
  projectId?: string;
  goalId?: string;
  runTimeoutMs?: number;
  pollIntervalMs?: number;
  pollIntervalMaxMs?: number;
}

export interface RuntimeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export type {
  PluginRuntimeManifestMetadata,
  PluginRuntimeFactory,
  PluginRuntimeRegistration,
  FusionPlugin,
} from "@fusion/plugin-sdk";
