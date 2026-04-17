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
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";

const execAsync = promisify(exec);
import {
  createAgentSession,
  createCodingTools,
  createExtensionRuntime,
  createReadOnlyTools,
  DefaultResourceLoader,
  DefaultPackageManager,
  discoverAndLoadExtensions,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getEnabledPiExtensionPaths, getFusionAgentDir, getLegacyPiAgentDir, resolvePiExtensionProjectRoot } from "@fusion/core";
import {
  resolveSessionSkills,
  createSkillsOverrideFromSelection,
  type SkillSelectionContext,
} from "./skill-resolver.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";

export interface AgentResult {
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions). */
  sessionFile?: string;
}

export interface PromptableSession extends AgentSession {
  promptWithFallback: (prompt: string, options?: unknown) => Promise<void>;
}

export async function promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void> {
  const maybePromptable = session as Partial<PromptableSession>;
  if (typeof maybePromptable.promptWithFallback === "function") {
    console.error(`[pi] promptWithFallback: delegating to session.promptWithFallback (prompt length=${prompt.length})`);
    await maybePromptable.promptWithFallback(prompt, options);
    console.error(`[pi] promptWithFallback: completed`);
    return;
  }

  console.error(`[pi] promptWithFallback: calling session.prompt (prompt length=${prompt.length})`);
  try {
    if (options === undefined) {
      await session.prompt(prompt);
    } else {
      await (session.prompt as any)(prompt, options);
    }
    console.error(`[pi] promptWithFallback: prompt completed`);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (!isContextLimitError(errorMessage)) {
      console.error(`[pi] promptWithFallback: non-context error — propagating: ${errorMessage}`);
      throw err;
    }

    // Context limit error — attempt auto-compaction and retry once
    console.error(`[pi] promptWithFallback: context limit error — attempting auto-compaction`);
    const compactResult = await compactSessionContext(session);
    if (!compactResult) {
      console.error(`[pi] promptWithFallback: compaction unavailable — propagating original error`);
      throw err;
    }

    console.error(`[pi] promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
    try {
      if (options === undefined) {
        await session.prompt(prompt);
      } else {
        await (session.prompt as any)(prompt, options);
      }
      console.error(`[pi] promptWithFallback: prompt completed after auto-compaction`);
    } catch (retryErr: unknown) {
      const retryErrorMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
      console.error(`[pi] promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
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
  } catch {
    // Compaction failed — return null so caller can fall through to kill/requeue
    return null;
  }
}

export interface AgentOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  customTools?: ToolDefinition[];
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
    console.error(`[pi] ${kind} model ${provider}/${modelId} not in registry; using provider base model as template`);
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
    || normalized.includes("temporarily unavailable");
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

    const extensionsResult = await discoverAndLoadExtensions(
      [...getEnabledPiExtensionPaths(cwd), ...packageExtensionPaths],
      cwd,
      join(resolvePiExtensionProjectRoot(cwd), ".fusion", "disabled-auto-extension-discovery"),
    );

    for (const { path, error } of extensionsResult.errors) {
      console.error(`[extensions] Failed to load ${path}: ${error}`);
    }

    for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
      try {
        modelRegistry.registerProvider(name, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[extensions] Failed to register provider from ${extensionPath}: ${message}`);
      }
    }

    extensionsResult.runtime.pendingProviderRegistrations = [];
    modelRegistry.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[extensions] Failed to discover extensions: ${message}`);
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
function getProjectRootFromWorktree(cwd: string): string | null {
  // Match paths like /project/.worktrees/task-id or /project/.worktrees/task-id/...
  const match = cwd.match(/^(.+?)\/\.worktrees\/[^/]+/);
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
 * - Project root .fusion/memory.md is allowed (for durable project learnings)
 * - Task attachments under .fusion/tasks/N/attachments/ are allowed (for reading context files)
 * - All other paths outside the worktree are rejected
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot - Absolute path to the project root (derived from worktree)
 * @param requestedPath - The path being accessed
 * @returns true if allowed, false if rejected
 */
function isWorktreeAllowedPath(worktreePath: string, projectRoot: string, requestedPath: string): boolean {
  // Normalize paths
  const worktreeResolved = resolve(worktreePath);
  const projectRootResolved = resolve(projectRoot);
  const requestedResolved = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(worktreeResolved, requestedPath);

  // Check if path is inside the worktree
  const relToWorktree = relative(worktreeResolved, requestedResolved);
  if (!relToWorktree.startsWith("..") && !isAbsolute(relToWorktree)) {
    return true; // Path is inside the worktree
  }

  // Exception: project root `.fusion/memory.md` for durable project learnings
  const relToProjectRoot = relative(projectRootResolved, requestedResolved);
  if (relToProjectRoot === ".fusion/memory.md") {
    return true;
  }

  // Exception: task attachments under `.fusion/tasks/*/attachments/*`
  if (relToProjectRoot.match(/^\.fusion\/tasks\/[^/]+\/attachments\//)) {
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
        if (pathArg && !isWorktreeAllowedPath(worktreePath, projectRoot, pathArg)) {
          const relToProject = relative(projectRoot, pathArg);
          return {
            ok: false,
            error: `Path "${relToProject}" is outside the worktree boundary. ` +
              `Coding agents can only modify files inside the current worktree. ` +
              `Exception: .fusion/memory.md (project root) and .fusion/tasks/*/attachments/* are permitted for reading.`,
          };
        }

        // For bash, also check the working directory if specified
        const cwdArg = params.cwd as string | undefined;
        if (tool.name === "bash" && cwdArg && !isWorktreeAllowedPath(worktreePath, projectRoot, cwdArg)) {
          return {
            ok: false,
            error: `Working directory is outside the worktree boundary. ` +
              `Commands must run inside the worktree.`,
          };
        }

        // Call the original tool implementation with all arguments passed through
        return originalExecute(...args);
      },
    };
  });
}

/**
 * Create a pi agent session configured for fn.
 * Reuses the user's existing pi auth and model configuration.
 */
export async function createKbAgent(options: AgentOptions): Promise<AgentResult> {
  console.error(`[pi] createKbAgent called (cwd=${options.cwd}, tools=${options.tools}, provider=${options.defaultProvider}, model=${options.defaultModelId})`);
  const authStorage = createFusionAuthStorage();
  const modelRegistry = new ModelRegistry(authStorage, getModelRegistryModelsPath());
  await registerExtensionProviders(options.cwd, modelRegistry);

  const tools =
    options.tools === "readonly"
      ? createReadOnlyTools(options.cwd)
      : createCodingTools(options.cwd);

  // Detect if this is a worktree session and apply path boundaries
  const worktreePath = options.cwd;
  const projectRoot = getProjectRootFromWorktree(worktreePath);
  if (projectRoot) {
    await assertValidWorktreeSession(worktreePath, projectRoot);
  }
  const wrappedTools = wrapToolsWithBoundary(tools, worktreePath, projectRoot);

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
    console.error(`[pi] Using skills from convenience parameter: [${options.skills.join(", ")}]`);
    effectiveSkillSelection = {
      projectRootDir: options.cwd,
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
        console.error(`[pi] [skills] [${purpose}] ${diag.type}: ${diag.message}`);
      }
    }
    skillsOverrideFn = createSkillsOverrideFromSelection(selectionResult, {
      requestedSkillNames: effectiveSkillSelection.requestedSkillNames,
      sessionPurpose: effectiveSkillSelection.sessionPurpose,
    });
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: options.cwd,
    settingsManager,
    systemPromptOverride: () => options.systemPrompt,
    appendSystemPromptOverride: () => [],
    ...(skillsOverrideFn ? { skillsOverride: skillsOverrideFn } : {}),
  });
  await resourceLoader.reload();

  const sessionManager = options.sessionManager ?? SessionManager.inMemory();

  const createSessionWithModel = async (modelOverride?: typeof selectedModel) => {
    return createAgentSession({
      cwd: options.cwd,
      authStorage,
      modelRegistry,
      resourceLoader,
      tools: wrappedTools as any,
      customTools: options.customTools,
      sessionManager,
      settingsManager,
      ...(modelOverride ? { model: modelOverride } : {}),
    });
  };

  let sessionResult;
  let usingFallback = false;
  try {
    sessionResult = await createSessionWithModel(selectedModel);
    console.error(`[pi] Session created successfully (model=${selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "default"})`);
  } catch (err: any) {
    if (!fallbackModel || !selectedModel || !isRetryableModelSelectionError(err?.message || "")) {
      console.error(`[pi] Session creation failed: ${err.message}`);
      throw err;
    }
    console.error(`[pi] Primary model failed (${err.message}), trying fallback`);
    usingFallback = true;
    sessionResult = await createSessionWithModel(fallbackModel);
    console.error(`[pi] Fallback session created successfully`);
  }

  const { session } = sessionResult;
  const promptableSession = session as PromptableSession;

  promptableSession.promptWithFallback = async (prompt: string, promptOptions?: unknown) => {
    try {
      if (promptOptions === undefined) {
        await session.prompt(prompt);
      } else {
        await (session.prompt as any)(prompt, promptOptions);
      }
      return;
    } catch (err: any) {
      const errorMessage = err?.message || "";
      if (isContextLimitError(errorMessage)) {
        // Context limit error — attempt auto-compaction and retry once
        console.error(`[pi] promptWithFallback: context limit error — attempting auto-compaction`);
        const compactResult = await compactSessionContext(session);
        if (compactResult) {
          console.error(`[pi] promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
          try {
            if (promptOptions === undefined) {
              await session.prompt(prompt);
            } else {
              await (session.prompt as any)(prompt, promptOptions);
            }
            return;
          } catch (retryErr: any) {
            const retryErrorMessage = retryErr?.message || "";
            console.error(`[pi] promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
            // Throw original error to preserve original context
            throw err;
          }
        } else {
          console.error(`[pi] promptWithFallback: compaction unavailable — propagating original error`);
          throw err;
        }
      }

      if (!fallbackModel || usingFallback || !isRetryableModelSelectionError(errorMessage)) {
        throw err;
      }

      usingFallback = true;
      try {
        session.dispose();
      } catch {
        // ignore dispose errors while swapping sessions
      }

      const fallbackSessionResult = await createSessionWithModel(fallbackModel);
      const fallbackSession = fallbackSessionResult.session as PromptableSession;

      if (options.defaultThinkingLevel) {
        fallbackSession.setThinkingLevel(options.defaultThinkingLevel as any);
      }

      fallbackSession.subscribe((event) => {
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

      Object.setPrototypeOf(promptableSession, Object.getPrototypeOf(fallbackSession));
      Object.assign(promptableSession, fallbackSession);
      promptableSession.promptWithFallback = fallbackSession.promptWithFallback ?? promptableSession.promptWithFallback;

      // Retry with fallback model, also with auto-compaction support
      try {
        if (promptOptions === undefined) {
          await fallbackSession.prompt(prompt);
        } else {
          await (fallbackSession.prompt as any)(prompt, promptOptions);
        }
        return;
      } catch (fallbackErr: any) {
        const fallbackErrorMessage = fallbackErr?.message || "";
        if (isContextLimitError(fallbackErrorMessage)) {
          console.error(`[pi] promptWithFallback: fallback session context limit error — attempting auto-compaction`);
          const compactResult = await compactSessionContext(fallbackSession);
          if (compactResult) {
            console.error(`[pi] promptWithFallback: fallback compaction succeeded (${compactResult.tokensBefore} tokens) — retrying`);
            try {
              if (promptOptions === undefined) {
                await fallbackSession.prompt(prompt);
              } else {
                await (fallbackSession.prompt as any)(prompt, promptOptions);
              }
              return;
            } catch (retryErr: any) {
              const retryErrorMessage = retryErr?.message || "";
              console.error(`[pi] promptWithFallback: fallback retry after auto-compaction failed: ${retryErrorMessage}`);
              throw fallbackErr; // Throw original fallback error
            }
          } else {
            console.error(`[pi] promptWithFallback: fallback compaction unavailable — propagating original error`);
            throw fallbackErr;
          }
        }
        throw fallbackErr;
      }
    }
  };

  // Apply thinking level if specified
  if (options.defaultThinkingLevel) {
    promptableSession.setThinkingLevel(options.defaultThinkingLevel as any);
  }

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
