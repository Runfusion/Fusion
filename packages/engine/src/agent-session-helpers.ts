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
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import {
  isTestModeActive,
  resolveExecutionSettingsModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  TEST_MODE_RESOLVED,
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

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  if (assignedRuntimeModel.provider && assignedRuntimeModel.modelId) {
    return assignedRuntimeModel;
  }

  const resolvedTaskModel = resolveTaskExecutionModel(
    {
      modelProvider: taskModelProvider,
      modelId: taskModelId,
    },
    settings,
  );

  return {
    provider: resolvedTaskModel.provider,
    modelId: resolvedTaskModel.modelId,
  };
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

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  if (assignedRuntimeModel.provider && assignedRuntimeModel.modelId) {
    return assignedRuntimeModel;
  }

  const resolvedTaskPlanningModel = resolveTaskPlanningModel(
    {
      planningModelProvider: taskPlanningModelProvider,
      planningModelId: taskPlanningModelId,
    },
    settings,
  );

  return {
    provider: resolvedTaskPlanningModel.provider,
    modelId: resolvedTaskPlanningModel.modelId,
  };
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

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  const executionSettingsModel = resolveExecutionSettingsModel(settings);

  const defaultProvider = assignedRuntimeModel.provider ?? executionSettingsModel.provider;
  const defaultModelId = assignedRuntimeModel.modelId ?? executionSettingsModel.modelId;

  const executionPairAvailable = Boolean(executionSettingsModel.provider && executionSettingsModel.modelId);
  const defaultMatchesExecution =
    defaultProvider === executionSettingsModel.provider && defaultModelId === executionSettingsModel.modelId;

  return {
    defaultProvider,
    defaultModelId,
    fallbackProvider: executionPairAvailable && !defaultMatchesExecution ? executionSettingsModel.provider : undefined,
    fallbackModelId: executionPairAvailable && !defaultMatchesExecution ? executionSettingsModel.modelId : undefined,
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

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  if (assignedRuntimeModel.provider && assignedRuntimeModel.modelId) {
    return assignedRuntimeModel;
  }

  if (settings?.defaultProviderOverride && settings.defaultModelIdOverride) {
    return {
      provider: settings.defaultProviderOverride,
      modelId: settings.defaultModelIdOverride,
    };
  }

  return {
    provider: settings?.defaultProvider,
    modelId: settings?.defaultModelId,
  };
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
