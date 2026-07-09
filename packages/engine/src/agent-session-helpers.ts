/**
 * Helper functions for creating agent sessions with runtime resolution.
 *
 * These helpers wrap the runtime resolution pattern so that subsystems
 * don't need to duplicate the resolution logic. They use the resolver
 * to select the appropriate runtime and then delegate to it for session
 * creation and prompting.
 */

import type { AgentRuntimeOptions } from "./agent-runtime.js";
import type { SkillSelectionContext } from "./skill-resolver.js";
import type { PluginRunner } from "./plugin-runner.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  isTestModeActive,
  resolveExecutionSettingsModel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  TEST_MODE_RESOLVED,
  type ResolvedModelSelection,
  type Settings,
} from "@fusion/core";
import { resolveRuntime, buildRuntimeResolutionContext, isMockProviderId, type SessionPurpose } from "./runtime-resolution.js";
import { createLogger } from "./logger.js";
import { promptWithFallback, describeModel } from "./pi.js";
import type { RunAuditor } from "./run-audit.js";
import { MockAgentRuntime } from "./providers/mock-provider.js";

/** Logger for agent session helpers */
const sessionLog = createLogger("agent-session");
const mockRuntimeSingleton = new MockAgentRuntime();

function extractSkillNamesFromSelection(skillSelection: SkillSelectionContext | undefined): string[] {
  if (!skillSelection || !Array.isArray(skillSelection.requestedSkillNames)) {
    return [];
  }

  return skillSelection.requestedSkillNames
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
}

/**
 * Options for creating an agent session with runtime resolution.
 */
export interface ResolvedSessionOptions extends AgentRuntimeOptions {
  /** Session purpose for runtime selection */
  sessionPurpose: SessionPurpose;
  /** Plugin runner for runtime lookup. When provided, enables plugin runtime selection. */
  pluginRunner?: PluginRunner;
  /** Optional runtime hint from task/agent configuration */
  runtimeHint?: string;
  /**
   * Optional run-audit emitter; when provided, a `session:runtime-resolved`
   * database event is recorded at resolution time. No-ops when omitted to
   * preserve backward compatibility for callers that have not yet been wired
   * through.
   */
  runAuditor?: RunAuditor;
  /**
   * Optional settings used only to capture `testModeActive` in
   * `session:runtime-resolved` metadata.
   */
  settings?: Settings;
  /**
   * `beforeSpawnSession` and `taskEnv` are inherited from
   * {@link AgentRuntimeOptions}. Both are forwarded verbatim to
   * `runtime.createSession()`.
   */
}

/**
 * Result of creating an agent session with runtime resolution.
 */
export interface ResolvedSessionResult {
  /** The created agent session */
  session: AgentSession;
  /** Path to the persisted session file (undefined for in-memory sessions) */
  sessionFile?: string;
  /** The runtime ID that was used */
  runtimeId: string;
  /** Whether the runtime was explicitly configured */
  wasConfigured: boolean;
}

/**
 * Extract runtime hint from untyped runtimeConfig payload.
 *
 * FNXC:GrokCli 2026-07-09-00:00:
 * FN-7725: this is the exact seam the decided Grok CLI routing wiring (option
 * (a) in docs/grok-cli-contract.md "Wiring") depends on. When an agent's
 * Runtime Source is set to "Runtime" (NewAgentDialog.tsx/AgentDetailView.tsx)
 * with the bundled Grok Runtime plugin selected, `runtimeConfig.runtimeHint`
 * is `"grok"`, and this value flows unchanged into `resolveRuntime()`
 * (runtime-resolution.ts), which resolves the Grok plugin's `GrokRuntimeAdapter`
 * generically — the same chain already used by the hermes/droid plugin
 * runtimes, so no Grok-specific logic lives here. The direct xAI
 * OpenAI-compatible model path (grok-provider.ts) is untouched and remains
 * the default; this hint-based path is opt-in and additive.
 *
 * @param runtimeConfig - Agent/task runtime configuration
 * @returns normalized runtime hint or undefined when missing/invalid
 */
export function extractRuntimeHint(
  runtimeConfig: Record<string, unknown> | undefined,
): string | undefined {
  const hint = runtimeConfig?.runtimeHint;
  if (typeof hint !== "string") {
    return undefined;
  }

  const normalizedHint = hint.trim();
  return normalizedHint.length > 0 ? normalizedHint : undefined;
}

/**
 * Extract the model provider and id from an agent's runtimeConfig.
 *
 * The dashboard's NewAgentDialog stores the agent's selected model as a
 * single combined string `runtimeConfig.model = "provider/modelId"` (see
 * register-chat-routes.ts which parses the same shape). Older code paths
 * also looked at separate `modelProvider` / `modelId` fields. This helper
 * accepts either shape, preferring the combined `model` string.
 */
export function extractRuntimeModel(
  runtimeConfig: Record<string, unknown> | undefined,
): { provider: string | undefined; modelId: string | undefined } {
  const combined = typeof runtimeConfig?.model === "string" ? runtimeConfig.model.trim() : "";
  if (combined) {
    const slashIdx = combined.indexOf("/");
    if (slashIdx > 0 && slashIdx < combined.length - 1) {
      return {
        provider: combined.slice(0, slashIdx).trim() || undefined,
        modelId: combined.slice(slashIdx + 1).trim() || undefined,
      };
    }
  }

  const provider = typeof runtimeConfig?.modelProvider === "string" ? runtimeConfig.modelProvider.trim() : "";
  const modelId = typeof runtimeConfig?.modelId === "string" ? runtimeConfig.modelId.trim() : "";
  return {
    provider: provider || undefined,
    modelId: modelId || undefined,
  };
}

function hasCompleteRuntimeModel(
  model: ResolvedModelSelection,
): model is { provider: string; modelId: string } {
  return Boolean(model.provider && model.modelId);
}

function pickSettingsThenRuntimeModel(
  settingsModel: ResolvedModelSelection,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  // Project/task/global settings are the authoritative model hierarchy. The
  // assigned durable agent runtime model is only a final compatibility fallback
  // when the hierarchy produced no complete pair; partial runtime pairs must
  // never be mixed with settings fields or mask saved project overrides.
  if (settingsModel.provider && settingsModel.modelId) {
    return {
      provider: settingsModel.provider,
      modelId: settingsModel.modelId,
    };
  }

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  return hasCompleteRuntimeModel(assignedRuntimeModel)
    ? assignedRuntimeModel
    : {
      provider: settingsModel.provider,
      modelId: settingsModel.modelId,
    };
}

export function resolveExecutorSessionModel(
  taskModelProvider: string | undefined,
  taskModelId: string | undefined,
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return {
      provider: TEST_MODE_RESOLVED.provider,
      modelId: TEST_MODE_RESOLVED.modelId,
    };
  }

  const resolvedTaskModel = resolveTaskExecutionModel(
    {
      modelProvider: taskModelProvider,
      modelId: taskModelId,
    },
    settings,
  );

  return pickSettingsThenRuntimeModel(resolvedTaskModel, assignedAgentRuntimeConfig);
}

export function resolvePlanningSessionModel(
  taskPlanningModelProvider: string | undefined,
  taskPlanningModelId: string | undefined,
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return {
      provider: TEST_MODE_RESOLVED.provider,
      modelId: TEST_MODE_RESOLVED.modelId,
    };
  }

  const resolvedTaskPlanningModel = resolveTaskPlanningModel(
    {
      planningModelProvider: taskPlanningModelProvider,
      planningModelId: taskPlanningModelId,
    },
    settings,
  );

  return pickSettingsThenRuntimeModel(resolvedTaskPlanningModel, assignedAgentRuntimeConfig);
}

/**
 * FNXC:TriageModelFallback 2026-07-09-00:00:
 * When no explicit `planningFallback*`/global `fallback*` pair is configured, the
 * planning lane must still get a working fallback. Derive one implicitly from the
 * resolved project/global default (execution) model — the same resolver
 * `resolveHeartbeatSessionModels`/`resolveMergerSessionModel` use — so a retryable
 * primary-planner failure (e.g. provider 404/429) recovers via one distinct swap
 * instead of failing triage permanently (see FN-7719). Guard against self-swap
 * (implicit fallback === primary planning model) and skip entirely in test mode,
 * so the single-swap `usingFallback` ceiling in pi.ts and the terminal
 * ModelFallbackExhaustedError path are preserved unchanged.
 */
export function resolveImplicitPlanningFallbackModel(
  settings: Partial<Settings> | undefined,
  primaryProvider: string | undefined,
  primaryModelId: string | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return { provider: undefined, modelId: undefined };
  }

  const defaultModel = resolveProjectDefaultModel(settings);
  const resolvedModel = pickSettingsThenRuntimeModel(defaultModel, assignedAgentRuntimeConfig);

  if (!resolvedModel.provider || !resolvedModel.modelId) {
    return { provider: undefined, modelId: undefined };
  }

  // Self-swap guard: an implicit fallback identical to the primary planner
  // model would produce a misleading "fallback configured" message while
  // still hitting the terminal ModelFallbackExhaustedError path in pi.ts
  // (hasDistinctFallback requires the models to differ). Leave both fields
  // undefined so the existing terminal behavior is preserved cleanly.
  if (resolvedModel.provider === primaryProvider && resolvedModel.modelId === primaryModelId) {
    return { provider: undefined, modelId: undefined };
  }

  return resolvedModel;
}

export function resolveValidatorSessionModel(
  taskValidatorModelProvider: string | undefined,
  taskValidatorModelId: string | undefined,
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return {
      provider: TEST_MODE_RESOLVED.provider,
      modelId: TEST_MODE_RESOLVED.modelId,
    };
  }

  const resolvedTaskValidatorModel = resolveTaskValidatorModel(
    {
      validatorModelProvider: taskValidatorModelProvider,
      validatorModelId: taskValidatorModelId,
    },
    settings,
  );

  return pickSettingsThenRuntimeModel(resolvedTaskValidatorModel, assignedAgentRuntimeConfig);
}

export function resolveHeartbeatSessionModels(
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): {
  defaultProvider: string | undefined;
  defaultModelId: string | undefined;
  fallbackProvider: string | undefined;
  fallbackModelId: string | undefined;
} {
  if (isTestModeActive(settings)) {
    return {
      defaultProvider: TEST_MODE_RESOLVED.provider,
      defaultModelId: TEST_MODE_RESOLVED.modelId,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
    };
  }

  const executionSettingsModel = resolveExecutionSettingsModel(settings);
  const resolvedModel = pickSettingsThenRuntimeModel(executionSettingsModel, assignedAgentRuntimeConfig);

  return {
    defaultProvider: resolvedModel.provider,
    defaultModelId: resolvedModel.modelId,
    fallbackProvider: undefined,
    fallbackModelId: undefined,
  };
}

export function resolveMergerSessionModel(
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): { provider: string | undefined; modelId: string | undefined } {
  if (isTestModeActive(settings)) {
    return {
      provider: TEST_MODE_RESOLVED.provider,
      modelId: TEST_MODE_RESOLVED.modelId,
    };
  }

  // Merger intentionally uses the default lane rather than execution/validator
  // lanes. Validator-specific callers resolve `resolveValidatorSettingsModel`
  // before falling back here; generic merger work uses project/global defaults.
  const defaultModel = resolveProjectDefaultModel(settings);
  return pickSettingsThenRuntimeModel(defaultModel, assignedAgentRuntimeConfig);
}

/**
 * Create an agent session using runtime resolution.
 *
 * This function:
 * 1. Resolves the appropriate runtime based on sessionPurpose, runtimeHint, and pluginRunner
 * 2. Creates the session using the resolved runtime
 * 3. Returns the session along with metadata about which runtime was used
 *
 * @param options - Session creation options including purpose and runtime configuration
 * @returns Promise resolving to the session result with runtime metadata
 */
export async function createResolvedAgentSession(
  options: ResolvedSessionOptions,
): Promise<ResolvedSessionResult> {
  const { sessionPurpose, pluginRunner, runtimeHint, runAuditor, settings, ...runtimeOptionsRaw } = options;

  const skillNamesFromSelection = extractSkillNamesFromSelection(runtimeOptionsRaw.skillSelection);
  const mergedSkillNames = runtimeOptionsRaw.skills && runtimeOptionsRaw.skills.length > 0
    ? runtimeOptionsRaw.skills
    : skillNamesFromSelection;

  const runtimeOptions: AgentRuntimeOptions = {
    ...runtimeOptionsRaw,
    ...(mergedSkillNames.length > 0 ? { skills: mergedSkillNames } : {}),
  };
  // FNXC:McpConfig 2026-06-25-22:06:
  // createResolvedAgentSession is the common lane helper for executor, reviewer, validator, workflow model-node, summarization, and merger-adjacent paths that pass MCP through this seam. Preserve `mcpServers` verbatim here; runtime-resolution/pi own support-gated forwarding and content-free skip logging.

  const useMockRuntime = isMockProviderId(runtimeOptions.defaultProvider);
  const effectiveRuntimeOptions = useMockRuntime
    ? {
      ...runtimeOptions,
      runtimeContext: {
        ...runtimeOptions.runtimeContext,
        sessionPurpose,
      },
    }
    : runtimeOptions;

  const resolved = useMockRuntime
    ? {
      runtime: mockRuntimeSingleton,
      runtimeId: mockRuntimeSingleton.id,
      wasConfigured: true,
    }
    : await resolveRuntime(buildRuntimeResolutionContext(sessionPurpose, pluginRunner, runtimeHint));

  sessionLog.log(
    `[${sessionPurpose}] Using runtime "${resolved.runtimeId}" (configured=${resolved.wasConfigured})`,
  );

  try {
    await runAuditor?.database({
      type: "session:runtime-resolved",
      target: resolved.runtimeId,
      metadata: {
        sessionPurpose,
        runtimeId: resolved.runtimeId,
        wasConfigured: resolved.wasConfigured,
        provider: runtimeOptions.defaultProvider ?? null,
        modelId: runtimeOptions.defaultModelId ?? null,
        mockProviderActive: isMockProviderId(runtimeOptions.defaultProvider),
        testModeActive: settings ? isTestModeActive(settings) : false,
        ...(runtimeHint ? { runtimeHint } : {}),
        ...("fallbackReason" in resolved && resolved.fallbackReason ? { reason: resolved.fallbackReason } : {}),
      },
    });
  } catch (err) {
    sessionLog.warn(`[${sessionPurpose}] failed to record session:runtime-resolved audit: ${String(err)}`);
  }

  // Forward `beforeSpawnSession` to the runtime so it fires at the true
  // latest sync point (just before LLM session instantiation) rather than
  // here, before the runtime's own awaited setup work runs. See
  // AgentRuntimeOptions.beforeSpawnSession for the contract.
  const result = await resolved.runtime.createSession(effectiveRuntimeOptions);

  // Attach the resolved runtime's promptWithFallback as a bound method on the
  // session object when it is not already present. This is the dispatch hook
  // that pi.promptWithFallback (pi.ts:175) checks before falling through to its
  // own pi-native path. Plugin runtimes (hermes, openclaw, paperclip) do not
  // attach this method themselves; without it every prompt call would silently
  // bypass the plugin and go through pi's session.prompt() instead.
  //
  // The default pi runtime's createFnAgent (pi.ts:1143) already attaches
  // promptWithFallback to the session, so we only attach when it is absent.
  const session = result.session as AgentSession & { promptWithFallback?: unknown };
  if (typeof session.promptWithFallback !== "function") {
    const runtime = resolved.runtime;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (session as any).promptWithFallback = (
      prompt: string,
      options?: unknown,
    ) => runtime.promptWithFallback(session, prompt, options);
  }

  return {
    session: result.session,
    sessionFile: result.sessionFile,
    runtimeId: resolved.runtimeId,
    wasConfigured: resolved.wasConfigured,
  };
}

/**
 * Prompt an agent session with automatic retry and compaction.
 *
 * This is a convenience wrapper that delegates to the runtime's promptWithFallback.
 *
 * @param session - The session to prompt
 * @param prompt - The prompt text
 * @param options - Optional prompt options (e.g., images)
 */
export async function promptWithAutoRetry(
  session: AgentSession,
  prompt: string,
  options?: unknown,
): Promise<void> {
  return promptWithFallback(session, prompt, options);
}

/**
 * Get a human-readable model description from a session.
 *
 * @param session - The session to describe
 * @returns Model description string
 */
export async function describeAgentModel(session: AgentSession): Promise<string> {
  return describeModel(session);
}
