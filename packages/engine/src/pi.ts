/**
 * Shared pi SDK setup for fn engine agents.
 *
 * Uses Fusion auth for writes and legacy pi auth as a read-only fallback.
 * Provides factory functions for creating triage and executor agent sessions.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { existsSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";

const execAsync = promisify(exec);
import {
  createAgentSession,
  createBashTool,
  createCodingTools,
  createEditTool,
  createExtensionRuntime,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadOnlyTools,
  createReadTool,
  createWriteTool,
  DefaultResourceLoader,
  DefaultPackageManager,
  discoverAndLoadExtensions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getEnabledPiExtensionPaths, getFusionAgentDir, getLegacyPiAgentDir, reconcileClaudeCliPaths, reconcileDroidCliPaths, resolvePiExtensionProjectRoot } from "@fusion/core";
import type {
  AgentPermissionPolicyActionCategory,
  PermanentAgentActionCategory,
  PermanentAgentGatingContext,
} from "@fusion/core";
import {
  resolveSessionSkills,
  createSkillsOverrideFromSelection,
  type SkillSelectionContext,
} from "./skill-resolver.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";
import { piLog, extensionsLog } from "./logger.js";
import { readCustomProviders } from "./custom-providers.js";
import {
  buildGateRejection,
  evaluateAgentActionGate,
  resolveGateOutcome,
  type AgentActionGateContext,
} from "./agent-action-gate.js";
import { resolvePermanentAgentToolDecision } from "./permanent-agent-gating.js";

export interface AgentResult {
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions). */
  sessionFile?: string;
}

/**
 * Process-global list of extension paths to inject into every createFnAgent
 * session. Set once at startup by the host (cli's dashboard/daemon/serve)
 * before any sessions are created. The paths are passed to pi's
 * `DefaultResourceLoader` as `additionalExtensionPaths` so the cli's own
 * `@runfusion/fusion` extension (registering `fn_*` tools) is loaded inside
 * every agent session — including chat sessions that pass no `customTools`.
 */
let hostExtensionPaths: string[] = [];

export function setHostExtensionPaths(paths: readonly string[]): void {
  hostExtensionPaths = [...paths];
}

export function getHostExtensionPaths(): readonly string[] {
  return hostExtensionPaths;
}

export interface PromptableSession extends AgentSession {
  promptWithFallback: (prompt: string, options?: unknown) => Promise<void>;
}

interface SessionManagerLike {
  fileEntries?: Array<{ type?: string; message?: Record<string, unknown> }>;
  appendMessage?: (message: Record<string, unknown>) => void;
  _rewriteFile?: () => void;
}

interface ToolHookPayload {
  toolCall: unknown;
  args: unknown;
  result: { content?: unknown; details?: unknown };
  isError: boolean;
}

interface ToolHookResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

type AgentToolHookSession = AgentSession & {
  agent?: {
    afterToolCall?: (payload: ToolHookPayload) => Promise<ToolHookResult | undefined>;
    state?: {
      messages?: Array<Record<string, unknown>>;
    };
  };
  __fusionToolResultGuardInstalled?: boolean;
  __fusionMessageContentGuardInstalled?: boolean;
};
const FN_MEMORY_APPEND_TOOL_NAME = "fn_memory_append";

function getSessionStateError(session: AgentSession): string {
  const state = (session as any).state;
  const error = state?.errorMessage ?? state?.error;
  return typeof error === "string" ? error : "";
}

function clearSessionStateError(session: AgentSession): void {
  const state = (session as any).state;
  if (!state || typeof state !== "object") {
    return;
  }

  // pi-coding-agent 0.70+ exposes `errorMessage` as readonly — writes are
  // silently ignored. Pre-0.70 used mutable `state.error`. Best-effort clear
  // both so transcripts carry forward to the next prompt cleanly.
  for (const key of ["errorMessage", "error"]) {
    if (key in state) {
      try {
        state[key] = undefined;
      } catch {
        // readonly — no-op
      }
    }
  }
}

function isThinkingReasoningConflictError(message: string): boolean {
  return /cannot specify both\s+['"]?thinking['"]?\s+and\s+['"]?reasoning_effort['"]?/i.test(message);
}

async function promptSessionAndCheck(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
  clearSessionStateError(session);
  if (options === undefined) {
    await session.prompt(prompt);
  } else {
    await (session.prompt as any)(prompt, options);
  }

  const stateError = getSessionStateError(session);
  if (stateError) {
    // pi-coding-agent swallows its own exceptions into state.errorMessage
    // without preserving a stack. When the message looks like a generic
    // TypeError (undefined/null property access), dump the session transcript
    // shape so the malformed message can be identified next time.
    if (/Cannot read propert(y|ies) of (undefined|null)/i.test(stateError)) {
      try {
        const messages = (session as any).agent?.state?.messages ?? (session as any).state?.messages;
        if (Array.isArray(messages)) {
          const recent = messages.slice(-6).map((m: Record<string, unknown>, idx: number) => {
            const i = messages.length - 6 + idx;
            const content = m?.content;
            return {
              index: i < 0 ? idx : i,
              role: m?.role,
              contentType: Array.isArray(content) ? `array(len=${content.length})` : typeof content,
              toolName: (m as { toolName?: unknown }).toolName,
              stopReason: (m as { stopReason?: unknown }).stopReason,
            };
          });
          piLog.error(`pi state error — transcript tail (${messages.length} msgs total): ${JSON.stringify(recent)}`);
        } else {
          piLog.error(`pi state error — state.messages is not an array: ${typeof messages}`);
        }
      } catch (inspectErr) {
        piLog.warn(`pi state error — failed to inspect transcript: ${inspectErr instanceof Error ? inspectErr.message : String(inspectErr)}`);
      }
    }
    // Some OpenAI-compatible providers (notably Moonshot/Kimi) end generation
    // with a non-standard `finish_reason: repeat` when their server-side
    // repetition detector trips. pi-ai surfaces this as a fatal state error,
    // but for our purposes the assistant turn is already complete — treat it
    // as a soft stop so the heartbeat keeps running.
    if (/Provider finish_reason:\s*repeat\b/i.test(stateError)) {
      piLog.warn(`pi state error — treating provider finish_reason=repeat as soft stop: ${stateError}`);
      clearSessionStateError(session);
      return;
    }
    // pi-ai's openai-codex-responses provider (Codex via ChatGPT-plan WebSocket)
    // surfaces transport drops as bare "WebSocket error" / "WebSocket closed".
    // The underlying ErrorEvent's `event.error` (cause/code) is dropped by
    // pi-ai's `extractWebSocketError` (it only inspects `event.message`), so
    // by the time we see the string the cause is gone. Tag the message with
    // the model identity so retry/transient classification can at least tell
    // which transport is unstable, and emit a structured warn for triage.
    if (/^WebSocket (error|closed)\b/i.test(stateError) || /WebSocket stream closed before response\.completed/i.test(stateError)) {
      const modelDesc = describeModel(session);
      piLog.warn(`pi state error — Codex WebSocket transport drop (model=${modelDesc}): ${stateError}`);
      throw new Error(`${stateError} (model=${modelDesc})`);
    }
    throw new Error(stateError);
  }
}

export async function promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
  const maybePromptable = session as Partial<PromptableSession>;
  if (typeof maybePromptable.promptWithFallback === "function") {
    piLog.log(`promptWithFallback: delegating to session.promptWithFallback (prompt length=${prompt.length})`);
    await maybePromptable.promptWithFallback(prompt, options);
    piLog.log("promptWithFallback: completed");
    return;
  }

  piLog.log(`promptWithFallback: calling session.prompt (prompt length=${prompt.length})`);
  try {
    await promptSessionAndCheck(session, prompt, options);
    piLog.log("promptWithFallback: prompt completed");
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!isContextLimitError(errorMessage)) {
      piLog.error(`promptWithFallback: non-context error — propagating: ${errorMessage}`);
      throw err;
    }

    // Context limit error — attempt auto-compaction and retry once
    const promptMemoryRetry = await retryWithCompactedPromptMemory(session, prompt, options);
    if (promptMemoryRetry.recovered) {
      return;
    }
    if (promptMemoryRetry.error) {
      const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
      if (!isContextLimitError(retryMessage)) {
        throw promptMemoryRetry.error;
      }
    }

    piLog.warn("promptWithFallback: context limit error — attempting auto-compaction");
    await flushMemoryBeforeSessionCompaction(session);
    const compactResult = await compactSessionContext(session);
    if (!compactResult) {
      piLog.error("promptWithFallback: compaction unavailable — propagating original error");
      throw err;
    }

    piLog.log(`promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
    try {
      await promptSessionAndCheck(session, prompt, options);
      piLog.log("promptWithFallback: prompt completed after auto-compaction");
    } catch (retryErr: unknown) {
      const retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      piLog.error(`promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
      throw err; // Throw original error to preserve original context
    }
  }
}

/**
 * Extract a human-readable model description from an AgentSession.
 * Returns `"<provider>/<modelId>"` (e.g. `"anthropic/claude-sonnet-4-5"`)
 * or `"unknown model"` when the session has no model set.
 */
export function describeModel(session: AgentSession): string {
  const model = session.model;
  if (!model) return "unknown model";
  return `${model.provider}/${model.id}`;
}

/**
 * Default instructions used when calling `session.compact()` for loop recovery.
 * These guide the compaction summary to preserve essential context while
 * freeing up the context window for continued work.
 */
export const COMPACTION_FALLBACK_INSTRUCTIONS = [
  "Summarize all completed steps concisely.",
  "Preserve the current step number and any in-progress work details.",
  "Keep references to key files, decisions, and error states.",
  "Discard verbose tool output, repeated attempts, and exploration history.",
].join(" ");

const MAX_COMPACTED_PROMPT_MEMORY_CHARS = 8_000;

function compactMarkdownMemorySection(sectionBody: string): string {
  const lines = sectionBody.split("\n");
  const kept: string[] = [];
  let used = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const normalized = trimmed.trimStart();
    const isUseful =
      normalized.startsWith("##")
      || normalized.startsWith("- ")
      || normalized.startsWith("* ")
      || /^\d+\.\s/.test(normalized)
      || normalized.length === 0;

    if (!isUseful) {
      continue;
    }

    const nextLength = used + trimmed.length + 1;
    if (nextLength > MAX_COMPACTED_PROMPT_MEMORY_CHARS) {
      break;
    }

    kept.push(trimmed);
    used = nextLength;
  }

  const compacted = kept.join("\n").trim();
  if (compacted.length >= sectionBody.trim().length) {
    return sectionBody.trim();
  }

  return [
    compacted,
    "",
    `<!-- Memory compacted from ${sectionBody.length} characters to avoid context overflow. Use memory tools or the selected memory file later only if essential. -->`,
  ].join("\n").trim();
}

function compactPromptMemory(prompt: string): string | null {
  const sectionPattern = /(^|\n)(## (?:Project Memory|Agent Memory|Memory)\n\n)([\s\S]*?)(?=\n## [^#]|\n# [^#]|$)/g;
  let changed = false;
  const compactedPrompt = prompt.replace(sectionPattern, (match, prefix: string, heading: string, body: string) => {
    const trimmedBody = body.trim();
    if (trimmedBody.length <= MAX_COMPACTED_PROMPT_MEMORY_CHARS) {
      return match;
    }

    const compacted = compactMarkdownMemorySection(trimmedBody);
    if (compacted.length >= trimmedBody.length) {
      return match;
    }

    changed = true;
    return `${prefix}${heading}${compacted}`;
  });

  return changed && compactedPrompt.length < prompt.length ? compactedPrompt : null;
}

async function retryWithCompactedPromptMemory(
  session: AgentSession,
  prompt: string,
  options?: unknown,
): Promise<{ recovered: boolean; error?: unknown }> {
  const compactedPrompt = compactPromptMemory(prompt);
  if (!compactedPrompt) {
    return { recovered: false };
  }

  piLog.log(
    `promptWithFallback: retrying with compacted prompt memory (${prompt.length} → ${compactedPrompt.length} chars)`,
  );

  try {
    await promptSessionAndCheck(session, compactedPrompt, options);
    piLog.log("promptWithFallback: prompt completed after prompt-memory compaction");
    return { recovered: true };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    piLog.error(`promptWithFallback: retry after prompt-memory compaction failed: ${errorMessage}`);
    return { recovered: false, error: err };
  }
}

async function flushMemoryBeforeSessionCompaction(session: AgentSession): Promise<void> {
  if ((session as any).__fusionMemoryAppendAvailable !== true) {
    return;
  }

  const flushPrompt = [
    "Before context compaction, preserve only unresolved durable memory if needed.",
    "If fn_memory_append is available and you learned reusable project decisions/conventions/pitfalls/open loops or private operating context that is not already saved, append it now.",
    "Use scope=\"project\" for shared workspace knowledge and scope=\"agent\" for private operating context.",
    "Use layer=\"long-term\" for durable facts and layer=\"daily\" for running notes/open loops.",
    "If there is nothing durable to save, reply exactly: NONE.",
  ].join("\n");

  try {
    await promptSessionAndCheck(session, flushPrompt);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    piLog.warn(`promptWithFallback: memory flush before compaction skipped: ${errorMessage}`);
  }
}

/**
 * Compact an agent session's context to free up the context window.
 *
 * Uses the SDK's native `session.compact()` method when available (the
 * preferred path — it produces structured, LLM-generated summaries).
 *
 * @param session — The agent session to compact
 * @param customInstructions — Optional instructions for the compaction summary.
 *   When not provided, uses COMPACTION_FALLBACK_INSTRUCTIONS.
 * @returns The compaction result with summary and token metrics, or null if
 *   compaction was not available or failed.
 */
export async function compactSessionContext(
  session: AgentSession,
  customInstructions?: string,
): Promise<{ summary: string; tokensBefore: number } | null> {
  const instructions = customInstructions ?? COMPACTION_FALLBACK_INSTRUCTIONS;

  // Check if session.compact is available (runtime capability detection)
  if (typeof (session as any).compact !== "function") {
    return null;
  }

  try {
    const result = await (session as any).compact(instructions);
    if (result && typeof result === "object") {
      return {
        summary: result.summary ?? "",
        tokensBefore: result.tokensBefore ?? 0,
      };
    }
    return null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    piLog.warn(`Context compaction failed (will fall through to kill/requeue): ${msg}`);
    return null;
  }
}

export interface FallbackModelUsedPayload {
  primaryModel: string;
  fallbackModel: string;
  triggerPoint: "session-creation" | "prompt-time";
  taskId?: string;
  taskTitle?: string;
  timestamp?: string;
}

export type BuiltinWebToolName = "WebSearch" | "WebFetch";

export interface AgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  customTools?: ToolDefinition[];
  /** Optional allowlist of builtin runtime web tools to keep enabled. */
  builtinToolsAllowlist?: BuiltinWebToolName[];
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolStart?: (name: string, args?: Record<string, unknown>) => void;
  onToolEnd?: (name: string, isError: boolean, result?: unknown) => void;
  /** Default model provider (e.g. "anthropic"). Used with `defaultModelId` to select a specific model. */
  defaultProvider?: string;
  /** Default model ID within the provider (e.g. "claude-sonnet-4-5"). Used with `defaultProvider`. */
  defaultModelId?: string;
  /** Optional fallback model provider used when the primary selected model hits
   *  a retryable provider-side failure such as rate limiting or overload. */
  fallbackProvider?: string;
  /** Optional fallback model ID used with `fallbackProvider`. */
  fallbackModelId?: string;
  /** Default thinking effort level (e.g. "medium", "high"). When provided, sets the session's thinking level after creation. */
  defaultThinkingLevel?: string;
  /** Optional pre-configured SessionManager. When provided, the agent session
   *  uses this instead of creating an in-memory session. Pass a file-based
   *  SessionManager to enable session persistence and pause/resume. */
  sessionManager?: SessionManager;
  /** Optional skill selection context. When provided, the agent session's
   *  skills are filtered according to project execution settings and any
   *  caller-requested skill names. Omit to use default skill discovery
   *  (all discovered skills included). */
  skillSelection?: SkillSelectionContext;
  /** Convenience: skill names to include in the session. When provided
   *  (and `skillSelection` is not), auto-constructs a SkillSelectionContext
   *  from the cwd and these names. Ignored when `skillSelection` is set. */
  skills?: string[];
  /** Last-chance abort hook fired immediately before `createAgentSession`.
   *  See `AgentRuntimeOptions.beforeSpawnSession`. */
  beforeSpawnSession?: () => Promise<void> | void;
  /** Callback fired when runtime falls back from primary model to fallback model. */
  onFallbackModelUsed?: (payload: FallbackModelUsedPayload) => Promise<void> | void;
  /** Optional task context for fallback notifications. */
  taskId?: string;
  taskTitle?: string;
  actionGateContext?: AgentActionGateContext;
  /** Permanent-agent action gating context forwarded by runtime/session helpers. */
  permanentAgentGating?: PermanentAgentGatingContext;
}

function resolveConfiguredModel(
  modelRegistry: ModelRegistry,
  kind: "primary" | "fallback",
  provider?: string,
  modelId?: string,
) {
  if (!provider || !modelId) {
    return undefined;
  }

  const model = modelRegistry.find(provider, modelId);
  if (model) {
    return model;
  }

  // Fall back to constructing a model on-the-fly if the provider is known.
  // This mirrors the pi CLI's buildFallbackModel behaviour, which accepts any
  // model ID for a configured provider (e.g. any OpenRouter model string) even
  // when it isn't in the built-in or custom model list.
  const providerModels = modelRegistry.getAll().filter((m) => m.provider === provider);
  if (providerModels.length > 0) {
    const baseModel = providerModels[0]!;
    piLog.warn(`${kind} model ${provider}/${modelId} not in registry; using provider base model as template`);
    return { ...baseModel, id: modelId, name: modelId };
  }

  throw new Error(
    `Configured ${kind} model ${provider}/${modelId} was not found in the pi model registry. ` +
    "Open Settings and choose a model from /api/models, or update your pi model configuration.",
  );
}

function isRetryableModelSelectionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("rate limit")
    || normalized.includes("too many requests")
    || normalized.includes("429")
    || normalized.includes("401")
    || normalized.includes("403")
    || normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("authentication")
    || normalized.includes("invalid api key")
    || normalized.includes("invalid key")
    || normalized.includes("api key")
    || normalized.includes("overloaded")
    || normalized.includes("quota")
    || normalized.includes("capacity")
    || normalized.includes("temporarily unavailable")
    || normalized.includes("invalid temperature");
}

interface PackageManagerSettingsView {
  getGlobalSettings(): Record<string, any>;
  getProjectSettings(): Record<string, any>;
  getNpmCommand(): string[] | undefined;
}

function readJsonObject(path: string): Record<string, any> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

function normalizeSessionHistoryEntries(sessionManager: SessionManagerLike): void {
  const entries = sessionManager.fileEntries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return;
  }

  let changed = false;
  for (const entry of entries) {
    if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") {
      continue;
    }
    const role = entry.message.role;
    if (role !== "assistant" && role !== "toolResult") {
      continue;
    }
    if (!("content" in entry.message)) {
      entry.message.content = [];
      changed = true;
    }
  }

  if (changed) {
    sessionManager._rewriteFile?.();
  }
}

function normalizeAssistantOrToolResultMessage(message: unknown): message is Record<string, unknown> {
  if (!message || typeof message !== "object") {
    return false;
  }

  const role = (message as Record<string, unknown>).role;
  if (role !== "assistant" && role !== "toolResult" && role !== "user") {
    return false;
  }

  const obj = message as Record<string, unknown>;
  // `user` messages may carry content as a string (plain prompt) — leave those alone.
  // For any other shape (undefined, null, object, etc.) coerce to an empty array so
  // pi-coding-agent's _getUserMessageText (content.filter(...)) can't crash.
  if (role === "user") {
    if (typeof obj.content !== "string" && !Array.isArray(obj.content)) {
      obj.content = [];
    }
    return true;
  }

  if (!Array.isArray(obj.content)) {
    obj.content = [];
  }
  return true;
}

function syncNormalizedMessageIntoAgentState(session: AgentToolHookSession, message: Record<string, unknown>): void {
  const messages = session.agent?.state?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (candidate === message) {
      normalizeAssistantOrToolResultMessage(candidate);
      return;
    }

    if (candidate.role !== message.role) {
      continue;
    }

    if (candidate.role === "toolResult") {
      if (candidate.toolCallId === message.toolCallId && candidate.toolName === message.toolName) {
        normalizeAssistantOrToolResultMessage(candidate);
        return;
      }
      continue;
    }

    if (candidate.timestamp === message.timestamp) {
      normalizeAssistantOrToolResultMessage(candidate);
      return;
    }
  }
}

function installToolResultContentGuard(session: AgentToolHookSession): void {
  if (session.__fusionToolResultGuardInstalled || !session.agent?.afterToolCall) {
    return;
  }

  const originalAfterToolCall = session.agent.afterToolCall.bind(session.agent) as any;
  (session.agent as any).afterToolCall = async (payload: ToolHookPayload) => {
    const hookResult = await originalAfterToolCall(payload);
    if (!hookResult || typeof hookResult !== "object") {
      return hookResult;
    }

    const content = hookResult.content ?? payload.result?.content ?? [];
    return {
      content: Array.isArray(content) ? content : [],
      details: hookResult.details ?? payload.result?.details,
      isError: hookResult.isError ?? payload.isError,
    };
  };
  session.__fusionToolResultGuardInstalled = true;
}

function installMessageContentGuard(session: AgentToolHookSession, sessionManager: SessionManagerLike): void {
  if (session.__fusionMessageContentGuardInstalled) {
    return;
  }

  // Sweep any pre-existing state.messages (e.g. restored from a session file)
  // so messages with malformed content can't crash pi-coding-agent's
  // _getUserMessageText / similar array traversals before our event hooks fire.
  const existingMessages = session.agent?.state?.messages;
  if (Array.isArray(existingMessages)) {
    for (const candidate of existingMessages) {
      normalizeAssistantOrToolResultMessage(candidate);
    }
  }

  if (typeof session.subscribe === "function") {
    session.subscribe((event: unknown) => {
      if (!event || typeof event !== "object" || (event as { type?: string }).type !== "message_end") {
        return;
      }

      const message = (event as { message?: unknown }).message;
      if (!normalizeAssistantOrToolResultMessage(message)) {
        return;
      }

      syncNormalizedMessageIntoAgentState(session, message);
    });
  }

  if (typeof sessionManager.appendMessage === "function") {
    const originalAppendMessage = sessionManager.appendMessage.bind(sessionManager);
    sessionManager.appendMessage = (message: Record<string, unknown>) => {
      normalizeAssistantOrToolResultMessage(message);
      syncNormalizedMessageIntoAgentState(session, message);
      return originalAppendMessage(message);
    };
  }

  session.__fusionMessageContentGuardInstalled = true;
}

function hasPackageManagerSettings(settings: Record<string, any>): boolean {
  return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}

function siblingAgentDir(agentDir: string, siblingRoot: ".fusion" | ".pi"): string | undefined {
  if (basename(agentDir) !== "agent") {
    return undefined;
  }
  return join(dirname(dirname(agentDir)), siblingRoot, "agent");
}

function createReadOnlyPiSettingsView(cwd: string, agentDir: string): PackageManagerSettingsView {
  const projectRoot = resolvePiExtensionProjectRoot(cwd);
  const fusionAgentDir = agentDir.includes(`${join(".fusion", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".fusion");
  const legacyAgentDir = agentDir.includes(`${join(".pi", "agent")}`)
    ? agentDir
    : siblingAgentDir(agentDir, ".pi");
  const legacyGlobalSettings = legacyAgentDir ? readJsonObject(join(legacyAgentDir, "settings.json")) : {};
  const fusionGlobalSettings = fusionAgentDir ? readJsonObject(join(fusionAgentDir, "settings.json")) : {};
  const directGlobalSettings = readJsonObject(join(agentDir, "settings.json"));
  const globalSettings = { ...legacyGlobalSettings, ...directGlobalSettings, ...fusionGlobalSettings };
  const fusionProjectSettings = readJsonObject(join(projectRoot, ".fusion", "settings.json"));
  const mergedSettings = { ...globalSettings, ...fusionProjectSettings };

  return {
    getGlobalSettings: () => structuredClone(globalSettings),
    getProjectSettings: () => structuredClone(fusionProjectSettings),
    getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
      ? [...mergedSettings.npmCommand]
      : undefined,
  };
}

function getPackageManagerAgentDir(): string {
  const fusionAgentDir = getFusionAgentDir();
  const legacyAgentDir = getLegacyPiAgentDir();
  const fusionSettings = readJsonObject(join(fusionAgentDir, "settings.json"));
  const legacySettings = readJsonObject(join(legacyAgentDir, "settings.json"));

  if (hasPackageManagerSettings(fusionSettings) || !existsSync(legacyAgentDir)) {
    return fusionAgentDir;
  }
  if (hasPackageManagerSettings(legacySettings)) {
    return legacyAgentDir;
  }
  return existsSync(fusionAgentDir) ? fusionAgentDir : legacyAgentDir;
}

/**
 * Resolve the absolute path to Fusion's vendored `@fusion/pi-claude-cli`
 * extension entry. Used by `registerExtensionProviders` to ensure the fork
 * always wins over any externally-installed `pi-claude-cli`.
 *
 * Returns null when the vendored package isn't available (e.g. someone
 * embedded `@fusion/engine` standalone without bundling the fork) — callers
 * should treat that as "no override needed, leave external paths alone".
 */
function resolveVendoredClaudeCliEntry(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("@fusion/pi-claude-cli/package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      pi?: { extensions?: unknown };
    };
    const extensions = pkgJson.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0) return null;
    const entry = extensions[0];
    if (typeof entry !== "string" || entry.length === 0) return null;
    const path = resolve(dirname(pkgJsonPath), entry);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to Fusion's vendored `@fusion/droid-cli`
 * extension entry. Used by `registerExtensionProviders` to ensure the
 * vendored extension always wins over any externally-installed `droid-cli`.
 */
function resolveVendoredDroidCliEntry(): string | null {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJsonPath = require_.resolve("@fusion/droid-cli/package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
      pi?: { extensions?: unknown };
    };
    const extensions = pkgJson.pi?.extensions;
    if (!Array.isArray(extensions) || extensions.length === 0) return null;
    const entry = extensions[0];
    if (typeof entry !== "string" || entry.length === 0) return null;
    const path = resolve(dirname(pkgJsonPath), entry);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

async function registerExtensionProviders(cwd: string, modelRegistry: ModelRegistry): Promise<void> {
  try {
    const agentDir = getPackageManagerAgentDir();
    const packageManager = new DefaultPackageManager({
      cwd,
      agentDir,
      settingsManager: createReadOnlyPiSettingsView(cwd, agentDir) as any,
    });
    const resolvedPaths = await packageManager.resolve();
    const packageExtensionPaths = resolvedPaths.extensions
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path);

    // Always prefer Fusion's vendored `@fusion/pi-claude-cli` over any external
    // `pi-claude-cli` install (e.g. a global `npm install -g pi-claude-cli`,
    // or `npm:pi-claude-cli` in agent settings). Upstream has known timing
    // and once-and-lock MCP-config bugs that we fix in the fork; loading both
    // also produces unpredictable provider-registration winners.
    const vendoredClaudeCli = resolveVendoredClaudeCliEntry();
    const reconciledPaths = reconcileClaudeCliPaths(
      [...getEnabledPiExtensionPaths(cwd), ...packageExtensionPaths],
      vendoredClaudeCli,
    );

    // Prefer Fusion's vendored `@fusion/droid-cli` over any external
    // `droid-cli` install. Side-by-side loading of two extensions that
    // register the same provider name produces unpredictable winners.
    const vendoredDroidCli = resolveVendoredDroidCliEntry();
    const doubleReconciledPaths = reconcileDroidCliPaths(
      reconciledPaths,
      vendoredDroidCli,
    );

    const extensionsResult = await discoverAndLoadExtensions(
      doubleReconciledPaths,
      cwd,
      join(resolvePiExtensionProjectRoot(cwd), ".fusion", "disabled-auto-extension-discovery"),
    );

    for (const { path, error } of extensionsResult.errors) {
      extensionsLog.warn(`Failed to load ${path}: ${error}`);
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        extensionsLog.warn(`Failed to register provider from ${extensionPath}: ${message}`);
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    extensionsLog.error(`Failed to discover extensions: ${message}`);
    createExtensionRuntime();
    modelRegistry.refresh();
  }
}

// ── Worktree Path Boundary Helpers ──────────────────────────────────────────

/**
 * Detect if a path is a task worktree under `.worktrees/`.
 * Returns the project root if the path is a worktree, otherwise null.
 *
 * Examples:
 *   `/project/.worktrees/fn-001` → `/project`
 *   `/project/.worktrees/fn-001/src/file.ts` → `/project`
 *   `/project` → null (not a worktree)
 */
export function getProjectRootFromWorktree(cwd: string): string | null {
  // Match paths like:
  //   /project/.worktrees/task-id
  //   /project/.worktrees/task-id/src/file.ts
  //   C:\project\.worktrees\task-id
  const match = cwd.match(/^(.+?)[\\/]\.worktrees[\\/][^\\/]+(?:[\\/]|$)/);
  if (match) {
    return match[1]!;
  }
  return null;
}

async function isRegisteredGitWorktree(projectRoot: string, worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: projectRoot,
      encoding: "utf-8",
    });
    const resolvedWorktree = resolve(worktreePath);
    return stdout.split("\n").some((line) =>
      line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === resolvedWorktree
    );
  } catch {
    return false;
  }
}

async function isCompleteGitWorktree(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync("git rev-parse --show-toplevel", {
      cwd: worktreePath,
      encoding: "utf-8",
    });
    return resolve(stdout.trim()) === resolve(worktreePath);
  } catch {
    return false;
  }
}

async function assertValidWorktreeSession(cwd: string, projectRoot: string): Promise<void> {
  if (!existsSync(cwd)) {
    throw new Error(`Refusing to start coding agent in missing worktree: ${cwd}`);
  }
  if (!existsSync(join(cwd, ".git")) || !await isCompleteGitWorktree(cwd)) {
    throw new Error(`Refusing to start coding agent in incomplete worktree: ${cwd}`);
  }
  if (!await isRegisteredGitWorktree(projectRoot, cwd)) {
    throw new Error(`Refusing to start coding agent in unregistered git worktree: ${cwd}`);
  }
}

/**
 * Check if a path is allowed to be accessed from a worktree session.
 * Rules:
 * - Paths inside the worktree are always allowed
 * - Project root .fusion/memory/ files are allowed (for durable project learnings)
 * - Task attachments under .fusion/tasks/N/attachments/ are allowed (for reading context files)
 * - Sibling task specs (.fusion/tasks/N/PROMPT.md and task.json) are allowed for
 *   read-only tools (read/glob/grep) so agents can consult dependency specs.
 * - All other paths outside the worktree are rejected
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot - Absolute path to the project root (derived from worktree)
 * @param requestedPath - The path being accessed
 * @param toolName - Tool making the request (controls read-only exceptions)
 * @returns true if allowed, false if rejected
 */
function isWorktreeAllowedPath(
  worktreePath: string,
  projectRoot: string,
  requestedPath: string,
  toolName?: string,
): boolean {
  // Normalize paths
  const worktreeResolved = resolve(worktreePath);
  const projectRootResolved = resolve(projectRoot);
  const requestedResolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(worktreeResolved, requestedPath);

  // Check if path is inside the worktree
  const relToWorktree = relative(worktreeResolved, requestedResolved);
  if (!relToWorktree.startsWith("..") && !isAbsolute(relToWorktree)) {
    return true; // Path is inside the worktree
  }

  // Exception: project root `.fusion/memory/` files for durable project learnings
  const relToProjectRoot = relative(projectRootResolved, requestedResolved).replace(/\\/g, "/");
  if (
    relToProjectRoot === ".fusion/memory" ||
    relToProjectRoot === ".fusion/memory/" ||
    relToProjectRoot.startsWith(".fusion/memory/")
  ) {
    return true;
  }

  // Exception: task attachments under `.fusion/tasks/*/attachments/*`
  if (relToProjectRoot.match(/^\.fusion\/tasks\/[^/]+\/attachments\//)) {
    return true;
  }

  // Exception (read-only): sibling task specs so the agent can consult the
  // PROMPT.md / task.json of dependency tasks without needing them copied
  // into the worktree. `glob`/`grep` are narrow enough to allow as well so
  // the agent can discover them; writes and bash remain restricted.
  const readOnlyTools = new Set(["read", "glob", "grep"]);
  if (toolName && readOnlyTools.has(toolName) &&
      /^\.fusion\/tasks\/[^/]+\/(PROMPT\.md|task\.json)$/.test(relToProjectRoot)) {
    return true;
  }

  // All other paths outside the worktree are rejected
  return false;
}

/**
 * Wrap tools with worktree boundary validation.
 * When cwd is a worktree path, file operations are validated against worktree boundaries.
 *
 * @param tools - Array of tool definitions to wrap
 * @param worktreePath - Absolute path to the worktree directory (if applicable)
 * @param projectRoot - Absolute path to the project root (if applicable)
 * @returns Wrapped tools with boundary validation
 */
/**
 * Build a tool result payload in the shape pi-coding-agent / pi-ai expect
 * (content as an array of typed blocks, isError=true) rather than a bare
 * `{ok:false,error}` object. Returning the bare object leaves the toolResult
 * message with `content: undefined`, which pi's downstream handling later
 * crashes on with "Cannot read properties of undefined (reading 'filter')".
 */
function boundaryRejection(message: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    ok: false,
    error: message,
    ...(details ? { details } : {}),
  };
}

function normalizeApprovalRequestCategory(
  category: PermanentAgentActionCategory,
): AgentPermissionPolicyActionCategory {
  if (category === "none") {
    return "command_execution";
  }
  return category;
}

function buildPermanentAgentApprovalDedupeKey(input: {
  requesterActorId?: string;
  taskId?: string;
  toolName: string;
  category: PermanentAgentActionCategory;
}): string {
  return [
    input.requesterActorId ?? "",
    input.taskId ?? "",
    input.toolName,
    input.category,
  ].join("|");
}

export function wrapToolsWithBoundary(
  tools: ToolDefinition[],
  worktreePath: string | null,
  projectRoot: string | null,
): ToolDefinition[] {
  if (!worktreePath || !projectRoot) {
    return tools; // Not a worktree session, no wrapping needed
  }

  return tools.map((tool) => {
    // Only wrap tools that access the filesystem
    const fileToolNames = new Set(["read", "write", "edit", "glob", "grep", "bash"]);
    if (!fileToolNames.has(tool.name)) {
      return tool;
    }

    // Store the original execute function
    const originalExecute = tool.execute as any;

     
    return {
      ...tool,
       
      execute: async (...args: any[]) => {
        const _toolCallId = args[0] as string;
        const params = args[1] as Record<string, unknown>;
        const _signal = args[2] as AbortSignal | undefined;

        // Check path argument for file operations
        const pathArg = params.path as string | undefined;
        if (pathArg && !isWorktreeAllowedPath(worktreePath, projectRoot, pathArg, tool.name)) {
          const relToProject = relative(projectRoot, pathArg);
          return boundaryRejection(
            `Path "${relToProject}" is outside the worktree boundary. ` +
              `Coding agents can only modify files inside the current worktree. ` +
              `Exceptions (read-only): .fusion/memory/, .fusion/tasks/*/attachments/, ` +
              `and .fusion/tasks/*/{PROMPT.md,task.json} for dependency context.`,
          );
        }

        // For bash, also check the working directory if specified
        const cwdArg = params.cwd as string | undefined;
        if (tool.name === "bash" && cwdArg && !isWorktreeAllowedPath(worktreePath, projectRoot, cwdArg, tool.name)) {
          return boundaryRejection(
            `Working directory is outside the worktree boundary. ` +
              `Commands must run inside the worktree.`,
          );
        }

        // Call the original tool implementation with all arguments passed through
        return originalExecute(...args);
      },
    };
  });
}

export function wrapToolsWithPermanentAgentGating(
  tools: ToolDefinition[],
  gating: PermanentAgentGatingContext | undefined,
): ToolDefinition[] {
  if (!gating) {
    return tools;
  }

  return tools.map((tool) => {
    const originalExecute = tool.execute as any;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const params = (args[1] ?? {}) as Record<string, unknown>;
        const decision = resolvePermanentAgentToolDecision({
          toolName: tool.name,
          args: params,
          gating,
        });

        if (decision.disposition === "allow") {
          return originalExecute(...args);
        }

        const details: Record<string, unknown> = {
          disposition: decision.disposition,
          category: decision.category,
          toolName: decision.toolName,
          ...(decision.disposition === "require-approval" ? { requiresApproval: true } : {}),
        };

        if (decision.disposition === "require-approval") {
          const dedupeKey = buildPermanentAgentApprovalDedupeKey({
            requesterActorId: gating.requester?.actorId,
            taskId: gating.taskId,
            toolName: decision.toolName,
            category: decision.category,
          });
          details.approvalDedupeKey = dedupeKey;

          let approvalRequest = await gating.findPendingApprovalRequest?.(dedupeKey);
          if (!approvalRequest && gating.createApprovalRequest) {
            approvalRequest = await gating.createApprovalRequest({
              category: normalizeApprovalRequestCategory(decision.category),
              toolName: decision.toolName,
              args: params,
            });
          }

          if (approvalRequest?.id) {
            details.approvalRequestId = approvalRequest.id;
          }
        }

        const reason = decision.disposition === "block"
          ? `Action blocked by permanent-agent policy (${decision.category}) for tool ${decision.toolName}`
          : `Action requires approval (${decision.category}) before tool ${decision.toolName} can run`;

        return boundaryRejection(reason, details);
      },
    };
  });
}

export function wrapToolsWithActionGate(
  tools: ToolDefinition[],
  gateContext: AgentActionGateContext | undefined,
): ToolDefinition[] {
  if (!gateContext || gateContext.isEphemeral) {
    return tools;
  }

  return tools.map((tool) => {
    const originalExecute = tool.execute as any;
    return {
      ...tool,
      execute: async (...args: any[]) => {
        const params = (args[1] ?? {}) as Record<string, unknown>;
        const decision = evaluateAgentActionGate({
          agentId: gateContext.agentId,
          taskId: gateContext.taskId,
          toolName: tool.name,
          args: params,
          permissionPolicy: gateContext.permissionPolicy,
        });

        const latestApproval = gateContext.findApprovalByDedupeKey
          ? await gateContext.findApprovalByDedupeKey(decision.approvalDedupeKey)
          : await gateContext.findPendingApprovalByDedupeKey?.(decision.approvalDedupeKey).then((request) =>
            request ? { id: request.id, status: "pending" as const } : null
          );

        const gateOutcome = resolveGateOutcome(decision, latestApproval ?? null);

        if (gateOutcome.outcome === "allow") {
          return originalExecute(...args);
        }

        if (gateOutcome.outcome === "execute-once-then-complete") {
          const result = await originalExecute(...args);
          if (gateOutcome.approvalRequestId) {
            await gateContext.markApprovalCompleted?.(gateOutcome.approvalRequestId);
          }
          return result;
        }

        if (gateOutcome.outcome === "block") {
          if (latestApproval?.status === "denied") {
            return buildGateRejection(
              {
                ...decision,
                metadata: {
                  ...decision.metadata,
                  approvalRequestId: latestApproval.id,
                  dedupeKey: decision.approvalDedupeKey,
                },
              },
              "Action was denied by approver. The agent must not retry this action.",
            );
          }

          return buildGateRejection(
            decision,
            `Action blocked by permission policy (${decision.category}) for ${gateContext.agentName}`,
          );
        }

        let approvalRequestId = gateOutcome.approvalRequestId;
        if (!approvalRequestId) {
          const created = await gateContext.createApprovalRequest(decision, params) as { id?: string } | null;
          approvalRequestId = created?.id;
          if (approvalRequestId) {
            await gateContext.pauseForApproval?.({ approvalRequestId, decision });
          }
        }

        return buildGateRejection(
          {
            ...decision,
            metadata: {
              ...decision.metadata,
              ...(approvalRequestId ? { approvalRequestId } : {}),
              dedupeKey: decision.approvalDedupeKey,
            },
          },
          `Action requires approval (request ${approvalRequestId ?? "pending"}). Agent and task have been paused; will resume once a decision is made.`,
        );
      },
    };
  });
}

/**
 * Create a pi agent session configured for fn.
 * Reuses the user's existing pi auth and model configuration.
 */
export async function createFnAgent(options: AgentOptions): Promise<AgentResult> {
  piLog.log(`createFnAgent called (tools=${options.tools}, provider=${options.defaultProvider}, model=${options.defaultModelId})`);
  const authStorage = createFusionAuthStorage();
  const modelRegistry = ModelRegistry.create(authStorage, getModelRegistryModelsPath());

  // Resolve the project root early so extension providers, skill discovery,
  // and resource loading all use the correct root when cwd is a worktree,
  // subdirectory, or any path other than the project root itself.
  const resolvedProjectRoot = getProjectRootFromWorktree(options.cwd) ?? resolvePiExtensionProjectRoot(options.cwd);
  await registerExtensionProviders(resolvedProjectRoot, modelRegistry);

  for (const provider of readCustomProviders()) {
    try {
      modelRegistry.registerProvider(provider.id, {
        baseUrl: provider.baseUrl,
        api: provider.apiType === "anthropic-compatible" ? "anthropic" : "openai-completions",
        apiKey: provider.apiKey,
        models: (provider.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: false,
          input: ["text" as const],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 128000,
          maxTokens: 16384,
        })),
      });
      piLog.log(`Registered custom provider ${provider.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      piLog.warn(`Failed to register custom provider ${provider.id}: ${message}`);
    }
  }
  modelRegistry.refresh();

  // Build the pi built-in tool set. We deliberately do NOT use the bundled
  // `createCodingTools` / `createReadOnlyTools` presets — they're missing
  // tools that pi-claude-cli's Claude→pi name mapping depends on (Glob→find,
  // Grep→grep). When a coding session ran via Claude CLI tried `Glob`, pi
  // returned "Tool find not found" and the agent looped. Compose explicitly
  // so every tool referenced by tool-mapping.ts is registered.
  const tools =
    options.tools === "readonly"
      ? [
          createReadTool(options.cwd),
          createGrepTool(options.cwd),
          createFindTool(options.cwd),
          createLsTool(options.cwd),
        ]
      : [
          createReadTool(options.cwd),
          createBashTool(options.cwd),
          createEditTool(options.cwd),
          createWriteTool(options.cwd),
          createGrepTool(options.cwd),
          createFindTool(options.cwd),
          createLsTool(options.cwd),
        ];
  // Suppress lint about unused presets — kept in scope for incremental migration.
  void createCodingTools;
  void createReadOnlyTools;

  // Detect if this is a worktree session and apply path boundaries
  const worktreePath = options.cwd;
  const worktreeProjectRoot = getProjectRootFromWorktree(worktreePath);
  if (worktreeProjectRoot) {
    await assertValidWorktreeSession(worktreePath, worktreeProjectRoot);
  }
  const boundaryContext = { worktreePath, worktreeProjectRoot };

  // resolvedProjectRoot was computed above (before registerExtensionProviders)
  // and is reused here for resource loader and skill discovery.

  // Compaction is explicitly enabled to prevent context-window overflow during
  // long-running agent conversations (triage, execution, review, merge).
  // When the context fills up, pi auto-compacts the conversation history to
  // keep the session alive without manual intervention. This must remain enabled
  // as a reliability safeguard — disabling it would cause overflow failures.
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  // Resolve explicit model selection if provider and model ID are specified
  const selectedModel = resolveConfiguredModel(
    modelRegistry,
    "primary",
    options.defaultProvider,
    options.defaultModelId,
  );
  const fallbackModel = resolveConfiguredModel(
    modelRegistry,
    "fallback",
    options.fallbackProvider,
    options.fallbackModelId,
  );

  // Resolve skill selection: explicit skillSelection wins over convenience `skills`
  let effectiveSkillSelection: SkillSelectionContext | undefined = options.skillSelection;
  if (!effectiveSkillSelection && options.skills && options.skills.length > 0) {
    piLog.log(`Using skills from convenience parameter: [${options.skills.join(", ")}]`);
    effectiveSkillSelection = {
      projectRootDir: resolvedProjectRoot,
      requestedSkillNames: options.skills,
      sessionPurpose: "executor",
    };
  }

  // Resolve skill selection if provided
  let skillsOverrideFn: ReturnType<typeof createSkillsOverrideFromSelection> | undefined;
  if (effectiveSkillSelection) {
    const selectionResult = resolveSessionSkills(effectiveSkillSelection);
    if (selectionResult.diagnostics.length > 0) {
      const purpose = effectiveSkillSelection.sessionPurpose ?? "skills";
      for (const diag of selectionResult.diagnostics) {
        const msg = `[skills] [${purpose}] ${diag.type}: ${diag.message}`;
        if (diag.type === "error") piLog.error(msg);
        else if (diag.type === "warning") piLog.warn(msg);
        else piLog.log(msg);
      }
    }
    skillsOverrideFn = createSkillsOverrideFromSelection(selectionResult, {
      requestedSkillNames: effectiveSkillSelection.requestedSkillNames,
      sessionPurpose: effectiveSkillSelection.sessionPurpose,
    });
  }

  // `tools: "readonly"` MUST mean a hermetically sealed read-only session with
  // respect to host extension injection. Host extensions (`@runfusion/fusion`)
  // can register write tools like `fn_task_create`, so they are deliberately
  // EXCLUDED in readonly mode. Caller-supplied `customTools` are preserved,
  // since heartbeat/reviewer flows explicitly provide engine-owned tools.
  // This keeps summarizer/compaction sessions safe while retaining intended
  // delegation/memory tools for readonly engine sessions.
  const isReadonly = options.tools === "readonly";
  const effectiveExtensionPaths = isReadonly ? [] : hostExtensionPaths;
  if (isReadonly && hostExtensionPaths.length > 0) {
    piLog.log(`readonly session — host extensions (${hostExtensionPaths.length}) skipped`);
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: resolvedProjectRoot,
    agentDir: getFusionAgentDir(),
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
    ...(effectiveExtensionPaths.length > 0 ? { additionalExtensionPaths: [...effectiveExtensionPaths] } : {}),
    ...(skillsOverrideFn ? { skillsOverride: skillsOverrideFn } : {}),
  });
  await resourceLoader.reload();

  const sessionManager = options.sessionManager ?? SessionManager.inMemory();
  normalizeSessionHistoryEntries(sessionManager as unknown as SessionManagerLike);

  const createSessionWithModel = async (modelOverride?: typeof selectedModel) => {
    // pi-coding-agent 0.68+: `tools` is a string[] allowlist of tool names, not
    // Tool instances. We need boundary-wrapped versions of the built-ins, so we
    // suppress the defaults with `noTools: "builtin"` and register our wrapped
    // tools through `customTools` instead. The wrapped tools preserve the same
    // names (`read`, `bash`, ...) as the built-ins they replace.
    const toolChainStart: ToolDefinition[] = [
      ...(tools as ToolDefinition[]),
      ...(options.customTools ?? []),
    ];
    const toolsWithPermanentGating = wrapToolsWithPermanentAgentGating(
      toolChainStart,
      options.permanentAgentGating,
    );
    const toolsWithActionGate = wrapToolsWithActionGate(
      toolsWithPermanentGating,
      options.actionGateContext,
    );
    const customToolList: ToolDefinition[] = wrapToolsWithBoundary(
      toolsWithActionGate,
      boundaryContext.worktreePath,
      boundaryContext.worktreeProjectRoot,
    );
    // Last-chance abort hook. Fires *here* — after every awaited setup step
    // in createFnAgent (provider registration, worktree validation, resource
    // loader reload) and immediately before the actual LLM session spawn.
    // This is the latest synchronous decision point where the engine can
    // honor a pause that flipped during this function's setup window.
    if (options.beforeSpawnSession) {
      await options.beforeSpawnSession();
    }
    const createSessionOptions: Parameters<typeof createAgentSession>[0] = {
      cwd: options.cwd,
      authStorage,
      modelRegistry,
      resourceLoader,
      noTools: "builtin",
      customTools: customToolList,
      sessionManager,
      settingsManager,
      ...(modelOverride ? { model: modelOverride } : {}),
    };

    if (options.builtinToolsAllowlist && options.builtinToolsAllowlist.length > 0) {
      createSessionOptions.tools = [
        ...new Set([
          ...customToolList.map((tool) => tool.name),
          ...options.builtinToolsAllowlist,
        ]),
      ];
    }

    return createAgentSession(createSessionOptions);
  };

  const emitFallbackUsed = async (triggerPoint: "session-creation" | "prompt-time"): Promise<void> => {
    if (!options.onFallbackModelUsed || !selectedModel || !fallbackModel) {
      return;
    }
    await options.onFallbackModelUsed({
      primaryModel: `${selectedModel.provider}/${selectedModel.id}`,
      fallbackModel: `${fallbackModel.provider}/${fallbackModel.id}`,
      triggerPoint,
      taskId: options.taskId,
      taskTitle: options.taskTitle,
      timestamp: new Date().toISOString(),
    });
  };

  let sessionResult;
  let usingFallback = false;
  try {
    sessionResult = await createSessionWithModel(selectedModel);
    piLog.log(`Session created successfully (model=${selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "default"})`);
  } catch (err: any) {
    if (!fallbackModel || !selectedModel || !isRetryableModelSelectionError(err?.message || "")) {
      piLog.error(`Session creation failed: ${err.message}`);
      throw err;
    }
    piLog.warn(`Primary model failed (${err.message}), trying fallback`);
    usingFallback = true;
    sessionResult = await createSessionWithModel(fallbackModel);
    await emitFallbackUsed("session-creation");
    piLog.log("Fallback session created successfully");
  }

  let activeSession = sessionResult.session;
  installToolResultContentGuard(activeSession as AgentToolHookSession);
  installMessageContentGuard(activeSession as AgentToolHookSession, sessionManager as unknown as SessionManagerLike);
  (activeSession as any).__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === FN_MEMORY_APPEND_TOOL_NAME) === true;
  const promptableSession = activeSession as PromptableSession;

  let thinkingCompatibilityDisabled = false;
  const applyThinkingLevelIfSupported = (targetSession: AgentSession, sourceModel: string): void => {
    if (!options.defaultThinkingLevel || thinkingCompatibilityDisabled) {
      return;
    }
    try {
      (targetSession as PromptableSession).setThinkingLevel(options.defaultThinkingLevel as any);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isThinkingReasoningConflictError(message)) {
        throw err;
      }
      thinkingCompatibilityDisabled = true;
      piLog.warn(`Disabling explicit thinking level for model ${sourceModel}: ${message}`);
    }
  };

  const wireFallbackHooks = (targetSession: PromptableSession): void => {
    installToolResultContentGuard(targetSession as unknown as AgentToolHookSession);
    installMessageContentGuard(
      targetSession as unknown as AgentToolHookSession,
      sessionManager as unknown as SessionManagerLike,
    );
    (targetSession as any).__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === FN_MEMORY_APPEND_TOOL_NAME) === true;
    targetSession.subscribe((event) => {
      if (event.type === "message_update") {
        const msgEvent = event.assistantMessageEvent;
        if (msgEvent.type === "text_delta") {
          options.onText?.(msgEvent.delta);
        } else if (msgEvent.type === "thinking_delta") {
          options.onThinking?.(msgEvent.delta);
        }
      }
      if (event.type === "tool_execution_start") {
        options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
      }
      if (event.type === "tool_execution_end") {
        options.onToolEnd?.(event.toolName, event.isError, event.result);
      }
    });
  };

  const swapPromptSession = async (modelToUse: typeof selectedModel): Promise<PromptableSession> => {
    if (!modelToUse) {
      throw new Error("Cannot swap session without a resolved model");
    }
    try {
      activeSession.dispose();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      piLog.warn(`Failed to dispose session during swap: ${msg}`);
    }
    const next = (await createSessionWithModel(modelToUse)).session as PromptableSession;
    wireFallbackHooks(next);
    applyThinkingLevelIfSupported(next, `${modelToUse.provider}/${modelToUse.id}`);
    Object.setPrototypeOf(promptableSession, Object.getPrototypeOf(next));
    Object.assign(promptableSession, next);
    promptableSession.promptWithFallback = next.promptWithFallback ?? promptableSession.promptWithFallback;
    activeSession = next;
    return next;
  };

  promptableSession.promptWithFallback = async (prompt: string, promptOptions?: unknown) => {
    try {
      await promptSessionAndCheck(activeSession, prompt, promptOptions);
      return;
    } catch (err: any) {
      const errorMessage = err?.message || "";
      if (isContextLimitError(errorMessage)) {
        // Context limit error — attempt auto-compaction and retry once
        const promptMemoryRetry = await retryWithCompactedPromptMemory(activeSession, prompt, promptOptions);
        if (promptMemoryRetry.recovered) {
          return;
        }
        if (promptMemoryRetry.error) {
          const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
          if (!isContextLimitError(retryMessage)) {
            throw promptMemoryRetry.error;
          }
        }

        piLog.warn("promptWithFallback: context limit error — attempting auto-compaction");
        await flushMemoryBeforeSessionCompaction(activeSession);
        const compactResult = await compactSessionContext(activeSession);
        if (compactResult) {
          piLog.log(`promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
          try {
            await promptSessionAndCheck(activeSession, prompt, promptOptions);
            return;
          } catch (retryErr: any) {
            const retryErrorMessage = retryErr?.message || "";
            piLog.error(`promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
            // Throw original error to preserve original context
            throw err;
          }
        } else {
          piLog.error("promptWithFallback: compaction unavailable — propagating original error");
          throw err;
        }
      }

      if (!usingFallback && options.defaultThinkingLevel && !thinkingCompatibilityDisabled && isThinkingReasoningConflictError(errorMessage)) {
        thinkingCompatibilityDisabled = true;
        piLog.warn(`Prompt failed with thinking/reasoning conflict; retrying without explicit thinking level: ${errorMessage}`);
        const recoveredSession = await swapPromptSession(selectedModel);
        await promptSessionAndCheck(recoveredSession, prompt, promptOptions);
        return;
      }

      if (!fallbackModel || usingFallback || !isRetryableModelSelectionError(errorMessage)) {
        throw err;
      }

      usingFallback = true;
      const fallbackSession = await swapPromptSession(fallbackModel);
      await emitFallbackUsed("prompt-time");

      // Retry with fallback model, also with auto-compaction support
      try {
        await promptSessionAndCheck(fallbackSession, prompt, promptOptions);
        return;
      } catch (fallbackErr: any) {
        const fallbackErrorMessage = fallbackErr?.message || "";
        if (isContextLimitError(fallbackErrorMessage)) {
          const promptMemoryRetry = await retryWithCompactedPromptMemory(fallbackSession, prompt, promptOptions);
          if (promptMemoryRetry.recovered) {
            return;
          }
          if (promptMemoryRetry.error) {
            const retryMessage = promptMemoryRetry.error instanceof Error ? promptMemoryRetry.error.message : String(promptMemoryRetry.error);
            if (!isContextLimitError(retryMessage)) {
              throw promptMemoryRetry.error;
            }
          }

          piLog.warn("promptWithFallback: fallback session context limit error — attempting auto-compaction");
          await flushMemoryBeforeSessionCompaction(fallbackSession);
          const compactResult = await compactSessionContext(fallbackSession);
          if (compactResult) {
            piLog.log(`promptWithFallback: fallback compaction succeeded (${compactResult.tokensBefore} tokens) — retrying`);
            try {
              await promptSessionAndCheck(fallbackSession, prompt, promptOptions);
              return;
            } catch (retryErr: any) {
              const retryErrorMessage = retryErr?.message || "";
              piLog.error(`promptWithFallback: fallback retry after auto-compaction failed: ${retryErrorMessage}`);
              throw fallbackErr; // Throw original fallback error
            }
          } else {
            piLog.error("promptWithFallback: fallback compaction unavailable — propagating original error");
            throw fallbackErr;
          }
        }
        throw fallbackErr;
      }
    }
  };

  // Apply thinking level if specified (with compatibility fallback).
  applyThinkingLevelIfSupported(
    promptableSession,
    selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : describeModel(promptableSession),
  );

  // Wire up event listeners
  promptableSession.subscribe((event) => {
    if (event.type === "message_update") {
      const msgEvent = event.assistantMessageEvent;
      if (msgEvent.type === "text_delta") {
        options.onText?.(msgEvent.delta);
      } else if (msgEvent.type === "thinking_delta") {
        options.onThinking?.(msgEvent.delta);
      }
    }
    if (event.type === "tool_execution_start") {
      options.onToolStart?.(event.toolName, event.args as Record<string, unknown> | undefined);
    }
    if (event.type === "tool_execution_end") {
      options.onToolEnd?.(event.toolName, event.isError, event.result);
    }
  });

  return { session: promptableSession, sessionFile: promptableSession.sessionFile };
}
