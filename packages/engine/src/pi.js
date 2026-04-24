/**
 * Shared pi SDK setup for fn engine agents.
 *
 * Uses Fusion auth for writes and legacy pi auth as a read-only fallback.
 * Provides factory functions for creating triage and executor agent sessions.
 */
import { existsSync, readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, relative, isAbsolute, resolve } from "node:path";
const execAsync = promisify(exec);
import { createAgentSession, createCodingTools, createExtensionRuntime, createReadOnlyTools, DefaultResourceLoader, DefaultPackageManager, discoverAndLoadExtensions, ModelRegistry, SessionManager, SettingsManager, } from "@mariozechner/pi-coding-agent";
import { getEnabledPiExtensionPaths, getFusionAgentDir, getLegacyPiAgentDir, resolvePiExtensionProjectRoot } from "@fusion/core";
import { resolveSessionSkills, createSkillsOverrideFromSelection, } from "./skill-resolver.js";
import { isContextLimitError } from "./context-limit-detector.js";
import { createFusionAuthStorage, getModelRegistryModelsPath } from "./auth-storage.js";
import { piLog, extensionsLog } from "./logger.js";
function getSessionStateError(session) {
    const error = session.state?.error;
    return typeof error === "string" ? error : "";
}
function clearSessionStateError(session) {
    const state = session.state;
    if (!state || typeof state !== "object" || !("error" in state)) {
        return;
    }
    try {
        state.error = undefined;
    }
    catch {
        // Best effort only. Some session implementations may expose readonly state.
    }
}
async function promptSessionAndCheck(session, prompt, options) {
    clearSessionStateError(session);
    if (options === undefined) {
        await session.prompt(prompt);
    }
    else {
        await session.prompt(prompt, options);
    }
    const stateError = getSessionStateError(session);
    if (stateError) {
        throw new Error(stateError);
    }
}
export async function promptWithFallback(session, prompt, options) {
    const maybePromptable = session;
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
    }
    catch (err) {
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
        }
        catch (retryErr) {
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
export function describeModel(session) {
    const model = session.model;
    if (!model)
        return "unknown model";
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
function compactMarkdownMemorySection(sectionBody) {
    const lines = sectionBody.split("\n");
    const kept = [];
    let used = 0;
    for (const line of lines) {
        const trimmed = line.trimEnd();
        const normalized = trimmed.trimStart();
        const isUseful = normalized.startsWith("##")
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
function compactPromptMemory(prompt) {
    const sectionPattern = /(^|\n)(## (?:Project Memory|Agent Memory|Memory)\n\n)([\s\S]*?)(?=\n## [^#]|\n# [^#]|$)/g;
    let changed = false;
    const compactedPrompt = prompt.replace(sectionPattern, (match, prefix, heading, body) => {
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
async function retryWithCompactedPromptMemory(session, prompt, options) {
    const compactedPrompt = compactPromptMemory(prompt);
    if (!compactedPrompt) {
        return { recovered: false };
    }
    piLog.log(`promptWithFallback: retrying with compacted prompt memory (${prompt.length} → ${compactedPrompt.length} chars)`);
    try {
        await promptSessionAndCheck(session, compactedPrompt, options);
        piLog.log("promptWithFallback: prompt completed after prompt-memory compaction");
        return { recovered: true };
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        piLog.error(`promptWithFallback: retry after prompt-memory compaction failed: ${errorMessage}`);
        return { recovered: false, error: err };
    }
}
async function flushMemoryBeforeSessionCompaction(session) {
    if (session.__fusionMemoryAppendAvailable !== true) {
        return;
    }
    const flushPrompt = [
        "Before context compaction, preserve only unresolved durable memory if needed.",
        "If memory_append is available and you learned reusable project decisions, conventions, pitfalls, or open loops that are not already saved, append them now.",
        "Use layer=\"long-term\" for durable facts and layer=\"daily\" for running notes/open loops.",
        "If there is nothing durable to save, reply exactly: NONE.",
    ].join("\n");
    try {
        await promptSessionAndCheck(session, flushPrompt);
    }
    catch (err) {
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
export async function compactSessionContext(session, customInstructions) {
    const instructions = customInstructions ?? COMPACTION_FALLBACK_INSTRUCTIONS;
    // Check if session.compact is available (runtime capability detection)
    if (typeof session.compact !== "function") {
        return null;
    }
    try {
        const result = await session.compact(instructions);
        if (result && typeof result === "object") {
            return {
                summary: result.summary ?? "",
                tokensBefore: result.tokensBefore ?? 0,
            };
        }
        return null;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        piLog.warn(`Context compaction failed (will fall through to kill/requeue): ${msg}`);
        return null;
    }
}
function resolveConfiguredModel(modelRegistry, kind, provider, modelId) {
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
        const baseModel = providerModels[0];
        piLog.warn(`${kind} model ${provider}/${modelId} not in registry; using provider base model as template`);
        return { ...baseModel, id: modelId, name: modelId };
    }
    throw new Error(`Configured ${kind} model ${provider}/${modelId} was not found in the pi model registry. ` +
        "Open Settings and choose a model from /api/models, or update your pi model configuration.");
}
function isRetryableModelSelectionError(message) {
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
function readJsonObject(path) {
    if (!existsSync(path)) {
        return {};
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function hasPackageManagerSettings(settings) {
    return Array.isArray(settings.packages) || Array.isArray(settings.npmCommand);
}
function siblingAgentDir(agentDir, siblingRoot) {
    if (basename(agentDir) !== "agent") {
        return undefined;
    }
    return join(dirname(dirname(agentDir)), siblingRoot, "agent");
}
function createReadOnlyPiSettingsView(cwd, agentDir) {
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
        getGlobalSettings: () => globalThis.structuredClone(globalSettings),
        getProjectSettings: () => globalThis.structuredClone(fusionProjectSettings),
        getNpmCommand: () => Array.isArray(mergedSettings.npmCommand)
            ? [...mergedSettings.npmCommand]
            : undefined,
    };
}
function getPackageManagerAgentDir() {
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
async function registerExtensionProviders(cwd, modelRegistry) {
    try {
        const agentDir = getPackageManagerAgentDir();
        const packageManager = new DefaultPackageManager({
            cwd,
            agentDir,
            settingsManager: createReadOnlyPiSettingsView(cwd, agentDir),
        });
        const resolvedPaths = await packageManager.resolve();
        const packageExtensionPaths = resolvedPaths.extensions
            .filter((resource) => resource.enabled)
            .map((resource) => resource.path);
        const extensionsResult = await discoverAndLoadExtensions([...getEnabledPiExtensionPaths(cwd), ...packageExtensionPaths], cwd, join(resolvePiExtensionProjectRoot(cwd), ".fusion", "disabled-auto-extension-discovery"));
        for (const { path, error } of extensionsResult.errors) {
            extensionsLog.warn(`Failed to load ${path}: ${error}`);
        }
        for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
            try {
                modelRegistry.registerProvider(name, config);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                extensionsLog.warn(`Failed to register provider from ${extensionPath}: ${message}`);
            }
        }
        extensionsResult.runtime.pendingProviderRegistrations = [];
        modelRegistry.refresh();
    }
    catch (error) {
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
function getProjectRootFromWorktree(cwd) {
    // Match paths like /project/.worktrees/task-id or /project/.worktrees/task-id/...
    const match = cwd.match(/^(.+?)\/\.worktrees\/[^/]+/);
    if (match) {
        return match[1];
    }
    return null;
}
async function isRegisteredGitWorktree(projectRoot, worktreePath) {
    try {
        const { stdout } = await execAsync("git worktree list --porcelain", {
            cwd: projectRoot,
            encoding: "utf-8",
        });
        const resolvedWorktree = resolve(worktreePath);
        return stdout.split("\n").some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === resolvedWorktree);
    }
    catch {
        return false;
    }
}
async function isCompleteGitWorktree(worktreePath) {
    try {
        const { stdout } = await execAsync("git rev-parse --show-toplevel", {
            cwd: worktreePath,
            encoding: "utf-8",
        });
        return resolve(stdout.trim()) === resolve(worktreePath);
    }
    catch {
        return false;
    }
}
async function assertValidWorktreeSession(cwd, projectRoot) {
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
 * - All other paths outside the worktree are rejected
 *
 * @param worktreePath - Absolute path to the worktree directory
 * @param projectRoot - Absolute path to the project root (derived from worktree)
 * @param requestedPath - The path being accessed
 * @returns true if allowed, false if rejected
 */
function isWorktreeAllowedPath(worktreePath, projectRoot, requestedPath) {
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
    if (relToProjectRoot === ".fusion/memory" ||
        relToProjectRoot === ".fusion/memory/" ||
        relToProjectRoot.startsWith(".fusion/memory/")) {
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
export function wrapToolsWithBoundary(tools, worktreePath, projectRoot) {
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
        const originalExecute = tool.execute;
        return {
            ...tool,
            execute: async (...args) => {
                const params = args[1];
                // Check path argument for file operations
                const pathArg = params.path;
                if (pathArg && !isWorktreeAllowedPath(worktreePath, projectRoot, pathArg)) {
                    const relToProject = relative(projectRoot, pathArg);
                    return {
                        ok: false,
                        error: `Path "${relToProject}" is outside the worktree boundary. ` +
                            `Coding agents can only modify files inside the current worktree. ` +
                            `Exception: .fusion/memory/ (project root) and .fusion/tasks/*/attachments/* are permitted for reading.`,
                    };
                }
                // For bash, also check the working directory if specified
                const cwdArg = params.cwd;
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
export async function createFnAgent(options) {
    piLog.log(`createFnAgent called (cwd=${options.cwd}, tools=${options.tools}, provider=${options.defaultProvider}, model=${options.defaultModelId})`);
    const authStorage = createFusionAuthStorage();
    const modelRegistry = new ModelRegistry(authStorage, getModelRegistryModelsPath());
    await registerExtensionProviders(options.cwd, modelRegistry);
    const tools = options.tools === "readonly"
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
    const selectedModel = resolveConfiguredModel(modelRegistry, "primary", options.defaultProvider, options.defaultModelId);
    const fallbackModel = resolveConfiguredModel(modelRegistry, "fallback", options.fallbackProvider, options.fallbackModelId);
    // Resolve skill selection: explicit skillSelection wins over convenience `skills`
    let effectiveSkillSelection = options.skillSelection;
    if (!effectiveSkillSelection && options.skills && options.skills.length > 0) {
        piLog.log(`Using skills from convenience parameter: [${options.skills.join(", ")}]`);
        effectiveSkillSelection = {
            projectRootDir: options.cwd,
            requestedSkillNames: options.skills,
            sessionPurpose: "executor",
        };
    }
    // Resolve skill selection if provided
    let skillsOverrideFn;
    if (effectiveSkillSelection) {
        const selectionResult = resolveSessionSkills(effectiveSkillSelection);
        if (selectionResult.diagnostics.length > 0) {
            const purpose = effectiveSkillSelection.sessionPurpose ?? "skills";
            for (const diag of selectionResult.diagnostics) {
                piLog.warn(`[skills] [${purpose}] ${diag.type}: ${diag.message}`);
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
    const createSessionWithModel = async (modelOverride) => {
        return createAgentSession({
            cwd: options.cwd,
            authStorage,
            modelRegistry,
            resourceLoader,
            tools: wrappedTools,
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
        piLog.log(`Session created successfully (model=${selectedModel ? `${selectedModel.provider}/${selectedModel.id}` : "default"})`);
    }
    catch (err) {
        if (!fallbackModel || !selectedModel || !isRetryableModelSelectionError(err?.message || "")) {
            piLog.error(`Session creation failed: ${err.message}`);
            throw err;
        }
        piLog.warn(`Primary model failed (${err.message}), trying fallback`);
        usingFallback = true;
        sessionResult = await createSessionWithModel(fallbackModel);
        piLog.log("Fallback session created successfully");
    }
    const { session } = sessionResult;
    session.__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === "memory_append") === true;
    const promptableSession = session;
    promptableSession.promptWithFallback = async (prompt, promptOptions) => {
        try {
            await promptSessionAndCheck(session, prompt, promptOptions);
            return;
        }
        catch (err) {
            const errorMessage = err?.message || "";
            if (isContextLimitError(errorMessage)) {
                // Context limit error — attempt auto-compaction and retry once
                const promptMemoryRetry = await retryWithCompactedPromptMemory(session, prompt, promptOptions);
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
                if (compactResult) {
                    piLog.log(`promptWithFallback: compaction succeeded (${compactResult.tokensBefore} tokens) — retrying prompt`);
                    try {
                        await promptSessionAndCheck(session, prompt, promptOptions);
                        return;
                    }
                    catch (retryErr) {
                        const retryErrorMessage = retryErr?.message || "";
                        piLog.error(`promptWithFallback: retry after auto-compaction failed: ${retryErrorMessage}`);
                        // Throw original error to preserve original context
                        throw err;
                    }
                }
                else {
                    piLog.error("promptWithFallback: compaction unavailable — propagating original error");
                    throw err;
                }
            }
            if (!fallbackModel || usingFallback || !isRetryableModelSelectionError(errorMessage)) {
                throw err;
            }
            usingFallback = true;
            try {
                session.dispose();
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                piLog.warn(`Failed to dispose session during model fallback swap: ${msg}`);
            }
            const fallbackSessionResult = await createSessionWithModel(fallbackModel);
            const fallbackSession = fallbackSessionResult.session;
            fallbackSession.__fusionMemoryAppendAvailable = options.customTools?.some((tool) => tool.name === "memory_append") === true;
            if (options.defaultThinkingLevel) {
                fallbackSession.setThinkingLevel(options.defaultThinkingLevel);
            }
            fallbackSession.subscribe((event) => {
                if (event.type === "message_update") {
                    const msgEvent = event.assistantMessageEvent;
                    if (msgEvent.type === "text_delta") {
                        options.onText?.(msgEvent.delta);
                    }
                    else if (msgEvent.type === "thinking_delta") {
                        options.onThinking?.(msgEvent.delta);
                    }
                }
                if (event.type === "tool_execution_start") {
                    options.onToolStart?.(event.toolName, event.args);
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
                await promptSessionAndCheck(fallbackSession, prompt, promptOptions);
                return;
            }
            catch (fallbackErr) {
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
                        }
                        catch (retryErr) {
                            const retryErrorMessage = retryErr?.message || "";
                            piLog.error(`promptWithFallback: fallback retry after auto-compaction failed: ${retryErrorMessage}`);
                            throw fallbackErr; // Throw original fallback error
                        }
                    }
                    else {
                        piLog.error("promptWithFallback: fallback compaction unavailable — propagating original error");
                        throw fallbackErr;
                    }
                }
                throw fallbackErr;
            }
        }
    };
    // Apply thinking level if specified
    if (options.defaultThinkingLevel) {
        promptableSession.setThinkingLevel(options.defaultThinkingLevel);
    }
    // Wire up event listeners
    promptableSession.subscribe((event) => {
        if (event.type === "message_update") {
            const msgEvent = event.assistantMessageEvent;
            if (msgEvent.type === "text_delta") {
                options.onText?.(msgEvent.delta);
            }
            else if (msgEvent.type === "thinking_delta") {
                options.onThinking?.(msgEvent.delta);
            }
        }
        if (event.type === "tool_execution_start") {
            options.onToolStart?.(event.toolName, event.args);
        }
        if (event.type === "tool_execution_end") {
            options.onToolEnd?.(event.toolName, event.isError, event.result);
        }
    });
    return { session: promptableSession, sessionFile: promptableSession.sessionFile };
}
//# sourceMappingURL=pi.js.map