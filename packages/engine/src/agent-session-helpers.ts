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
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  GROK_CLI_PROVIDER_ID,
  isGrokApiKeyFusionVisible,
  isTestModeActive,
  resolveExecutionSettingsModel,
  resolveMergerSettingsModel,
  resolvePhaseThinkingLevel,
  resolveProjectDefaultModel,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  TEST_MODE_RESOLVED,
  type ResolvedModelSelection,
  type Settings,
  type ThinkingLevel,
} from "@fusion/core";
import { resolveRuntime, buildRuntimeResolutionContext, isMockProviderId, type SessionPurpose } from "./runtime-resolution.js";
import { createLogger } from "./logger.js";
import {
  promptWithFallback,
  describeModel,
  wrapToolsWithActionGate,
  wrapToolsWithPermanentAgentGating,
  wrapToolsWithRtkRewrite,
} from "./pi.js";
import type { RunAuditor } from "./run-audit.js";
import { MockAgentRuntime } from "./providers/mock-provider.js";

/** Logger for agent session helpers */
const sessionLog = createLogger("agent-session");
const mockRuntimeSingleton = new MockAgentRuntime();

/*
FNXC:GrokAcp 2026-07-12-06:30:
Non-pi plugin runtimes (Grok ACP, Hermes, OpenClaw, …) receive `customTools` as
engine-injected `fn_*` ToolDefinitions and dispatch them via in-process execute
(or a loopback MCP bridge). Pi applies RTK rewrite → permanent-agent gating →
action gate inside `createFnAgent` before tools reach a session; plugin runtimes
previously skipped that chain and executed raw `execute` closures (Greptile P1
on PR #2011). Apply the same policy wrappers once here for every non-pi runtime
before `runtime.createSession`, so Grok/other CLI bridges cannot bypass gate
policy. Do not wrap for `pi` — `createFnAgent` still owns that chain and must
not double-wrap. Boundary jailing stays pi-local (needs worktree paths derived
inside createFnAgent).
*/

/** Runtime ids that already wrap customTools inside their own createSession path. */
const RUNTIMES_WITH_INTERNAL_TOOL_GATING = new Set(["pi"]);

/**
 * Apply Fusion tool policy wrappers for plugin runtimes that do not wrap tools
 * themselves. Mirrors the customTools portion of the pi createFnAgent chain.
 *
 * FNXC:GrokAcp 2026-07-12-06:35:
 * Missing `actionGateContext` / `permanentAgentGating` is intentionally fail-open
 * and matches `wrapToolsWithActionGate` / pi `createFnAgent`: when the caller
 * omits gate context (dashboard chat, room responders, triage), tools stay
 * ungated coordination primitives. Executor/heartbeat permanent-agent lanes
 * pass gate context and get full policy. Do not invent a deny-all default here —
 * that would break chat workflow tools on Grok while pi still allows them.
 * Emit a content-free warn (tool count + which layers were applied) so missing
 * context on a non-pi path is visible without logging tool names/args.
 */
export function wrapCustomToolsForPluginRuntime(
  tools: ToolDefinition[] | undefined,
  options: Pick<AgentRuntimeOptions, "actionGateContext" | "permanentAgentGating">,
  logContext?: { runtimeId: string; sessionPurpose: string },
): ToolDefinition[] | undefined {
  if (!tools || tools.length === 0) {
    return tools;
  }
  const hasActionGate = Boolean(options.actionGateContext) && options.actionGateContext?.isEphemeral !== true;
  const hasPermanentGate = Boolean(options.permanentAgentGating);
  if (!hasActionGate && !hasPermanentGate && logContext) {
    sessionLog.warn(
      `[${logContext.sessionPurpose}] non-pi runtime "${logContext.runtimeId}" received ${tools.length} customTool(s) without actionGateContext/permanentAgentGating; wrappers apply RTK rewrite only (matches pi fail-open when gate context is omitted)`,
    );
  }
  const withRtk = wrapToolsWithRtkRewrite(tools);
  const withPermanent = wrapToolsWithPermanentAgentGating(withRtk, options.permanentAgentGating);
  return wrapToolsWithActionGate(withPermanent, options.actionGateContext);
}

function shouldWrapCustomToolsForRuntime(runtimeId: string): boolean {
  return !RUNTIMES_WITH_INTERNAL_TOOL_GATING.has(runtimeId);
}

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


function firstThinkingLevel(...levels: Array<ThinkingLevel | string | undefined | null>): string | undefined {
  for (const level of levels) {
    if (typeof level === "string" && level.trim().length > 0) {
      return level.trim();
    }
  }
  return undefined;
}

/**
 * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
 * Model-lane thinking overrides must resolve through the same session option (`defaultThinkingLevel`) pi.ts already guards with the thinking/reasoning conflict fallback. Keep node/step thinking first when supplied by callers, then task, workflow lane, global lane, project default thinking override, and global default.
 */
export function resolveExecutorThinkingLevel(
  taskThinkingLevel: ThinkingLevel | string | undefined,
  settings: Partial<Settings> | undefined,
): string | undefined {
  return resolvePhaseThinkingLevel("execution", settings, taskThinkingLevel);
}

export function resolvePlanningThinkingLevel(
  settings: Partial<Settings> | undefined,
  taskThinkingLevel?: ThinkingLevel | string,
): string | undefined {
  return resolvePhaseThinkingLevel("planning", settings, taskThinkingLevel);
}

export function resolveValidatorThinkingLevel(
  taskThinkingLevel: ThinkingLevel | string | undefined,
  settings: Partial<Settings> | undefined,
): string | undefined {
  return resolvePhaseThinkingLevel("validation", settings, taskThinkingLevel);
}

export function resolveTitleSummarizerThinkingLevel(settings: Partial<Settings> | undefined): string | undefined {
  return firstThinkingLevel(
    settings?.titleSummarizerThinkingLevel,
    settings?.titleSummarizerGlobalThinkingLevel,
    settings?.defaultThinkingLevelOverride,
    settings?.defaultThinkingLevel,
  );
}

/**
 * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
 * Merger thinking must not inherit title-summarizer thinking (commit-message
 * summarization is a different session purpose).
 *
 * FNXC:Settings-MergerModel 2026-07-13-07:52:
 * After the merger model lane became configurable under Global/Project Models,
 * thinking follows the same precedence as other dedicated lanes: project merger
 * thinking → global merger thinking → project default thinking override → global
 * default thinking. Unset at every level preserves prior default-only behavior.
 */
export function resolveMergerThinkingLevel(settings: Partial<Settings> | undefined): string | undefined {
  return firstThinkingLevel(
    settings?.mergerThinkingLevel,
    settings?.mergerGlobalThinkingLevel,
    settings?.defaultThinkingLevelOverride,
    settings?.defaultThinkingLevel,
  );
}

/**
 * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
 * Fallback thinking resolvers mirror fallback provider/model precedence: lane-specific fallback thinking wins where a lane can select a lane fallback model, then global fallback thinking, then the primary lane/default thinking chain for compatibility when no fallback-specific value is configured.
 */
export function resolveExecutorFallbackThinkingLevel(
  taskThinkingLevel: ThinkingLevel | string | undefined,
  settings: Partial<Settings> | undefined,
): string | undefined {
  return firstThinkingLevel(
    settings?.fallbackThinkingLevel,
    resolveExecutorThinkingLevel(taskThinkingLevel, settings),
  );
}

export function resolvePlanningFallbackThinkingLevel(
  settings: Partial<Settings> | undefined,
  taskThinkingLevel?: ThinkingLevel | string,
): string | undefined {
  return firstThinkingLevel(
    settings?.planningFallbackThinkingLevel,
    settings?.fallbackThinkingLevel,
    resolvePlanningThinkingLevel(settings, taskThinkingLevel),
  );
}

export function resolveValidatorFallbackThinkingLevel(
  taskThinkingLevel: ThinkingLevel | string | undefined,
  settings: Partial<Settings> | undefined,
): string | undefined {
  return firstThinkingLevel(
    settings?.validatorFallbackThinkingLevel,
    settings?.fallbackThinkingLevel,
    resolveValidatorThinkingLevel(taskThinkingLevel, settings),
  );
}

export function resolveTitleSummarizerFallbackThinkingLevel(settings: Partial<Settings> | undefined): string | undefined {
  return firstThinkingLevel(
    settings?.titleSummarizerFallbackThinkingLevel,
    settings?.fallbackThinkingLevel,
    resolveTitleSummarizerThinkingLevel(settings),
  );
}

/*
FNXC:Settings-MergerModel 2026-07-16-00:00:
Merger recovery sessions use a lane-specific thinking level when configured, then preserve the former global-fallback and merger-primary inheritance order.
*/
export function resolveMergerFallbackThinkingLevel(settings: Partial<Settings> | undefined): string | undefined {
  return firstThinkingLevel(
    settings?.mergerFallbackThinkingLevel,
    settings?.fallbackThinkingLevel,
    resolveMergerThinkingLevel(settings),
  );
}

function hasCompleteRuntimeModel(
  model: ResolvedModelSelection,
): model is { provider: string; modelId: string } {
  return Boolean(model.provider && model.modelId);
}

function stripGrokCliModelProviderPrefix(modelId: string | undefined): string | undefined {
  const normalized = modelId?.trim();
  if (!normalized) return normalized;
  const grokCliPrefix = `${GROK_CLI_PROVIDER_ID}/`;
  return normalized.startsWith(grokCliPrefix)
    ? normalized.slice(grokCliPrefix.length)
    : normalized;
}

function buildMissingGrokRuntimeError(): Error {
  return new Error(
    "Grok CLI models require the bundled Grok CLI runtime when no Fusion-visible GROK_API_KEY is set. "
    + "Install and enable the Grok CLI runtime plugin, or set GROK_API_KEY to use the direct xAI endpoint.",
  );
}

function deriveGrokRuntimeHintForNoVisibleKey(
  runtimeOptions: AgentRuntimeOptions,
  pluginRunner: PluginRunner | undefined,
): string | undefined {
  if (runtimeOptions.defaultProvider !== GROK_CLI_PROVIDER_ID
    && runtimeOptions.fallbackProvider !== GROK_CLI_PROVIDER_ID) return undefined;
  if (isGrokApiKeyFusionVisible()) return undefined;
  try {
    if (pluginRunner?.getRuntimeById("grok")) return "grok";
  } catch {
    throw buildMissingGrokRuntimeError();
  }
  throw buildMissingGrokRuntimeError();
}

function applyGrokCliNoKeyRuntimeOptions(
  runtimeOptions: AgentRuntimeOptions,
): AgentRuntimeOptions {
  if (runtimeOptions.defaultProvider === GROK_CLI_PROVIDER_ID) {
    return {
      ...runtimeOptions,
      defaultModelId: stripGrokCliModelProviderPrefix(runtimeOptions.defaultModelId),
    };
  }

  if (runtimeOptions.fallbackProvider === GROK_CLI_PROVIDER_ID) {
    return {
      ...runtimeOptions,
      defaultProvider: runtimeOptions.fallbackProvider,
      defaultModelId: stripGrokCliModelProviderPrefix(runtimeOptions.fallbackModelId),
      /*
       * FNXC:Settings-ThinkingLevel 2026-07-10-00:00:
       * When the no-visible-key Grok CLI fallback is promoted to the primary runtime, promote its fallback thinking level too; the cleared fallback pair must not leave the Grok CLI session using the superseded primary model's thinking level.
       */
      defaultThinkingLevel: runtimeOptions.fallbackThinkingLevel ?? runtimeOptions.defaultThinkingLevel,
      fallbackProvider: undefined,
      fallbackModelId: undefined,
      fallbackThinkingLevel: undefined,
    };
  }

  return runtimeOptions;
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
    /*
    FNXC:TriageModelFallback 2026-07-14-15:54:
    A project default override can also become the resolved planning primary. When that makes the first implicit fallback a self-swap, try the distinct inherited global default pair before declaring that no fallback exists. This preserves the one-swap ceiling while allowing an authenticated global provider to recover a project-override auth failure.
    */
    const inheritedGlobalProvider = settings?.defaultProvider;
    const inheritedGlobalModelId = settings?.defaultModelId;
    if (
      inheritedGlobalProvider
      && inheritedGlobalModelId
      && (inheritedGlobalProvider !== primaryProvider || inheritedGlobalModelId !== primaryModelId)
    ) {
      return { provider: inheritedGlobalProvider, modelId: inheritedGlobalModelId };
    }
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
  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  /*
  FNXC:AgentHeartbeat 2026-07-14-16:13:
  Durable-agent heartbeats must use the complete model assigned to that agent. Shared project execution defaults are only a fallback for an absent or incomplete assignment; otherwise one broken project override can park every heterogeneous agent under the same unrelated provider.
  */
  const resolvedModel = hasCompleteRuntimeModel(assignedRuntimeModel)
    ? assignedRuntimeModel
    : pickSettingsThenRuntimeModel(executionSettingsModel, assignedAgentRuntimeConfig);

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

  /*
  FNXC:Settings-MergerModel 2026-07-13-07:52:
  Merger sessions use the dedicated merger settings lane (project → global → default),
  not execution/planning/validator. Session fallback still uses the shared global
  fallbackProvider/fallbackModelId pair at createResolvedAgentSession call sites.
  */
  const mergerModel = resolveMergerSettingsModel(settings);
  return pickSettingsThenRuntimeModel(mergerModel, assignedAgentRuntimeConfig);
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

  /*
  FNXC:GrokCliRouting 2026-07-09-00:00:
  FN-7753: when Built-in Model mode selects `grok-cli/*` but Fusion cannot see a GROK_API_KEY,
  derive the existing Grok plugin runtime hint automatically so the `grok` binary owns auth end-to-end.
  Explicit runtime hints always win, visible keys keep the direct xAI endpoint default, and mock/test-mode
  provider routing stays on the mock runtime. Strip only the provider-qualified model prefix so the CLI
  receives the concrete selected model via GrokRuntimeAdapter without changing non-grok sessions.

  FNXC:GrokCliRouting 2026-07-09-22:10:
  FN-7758 extends the no-visible-key invariant to configured fallback models. Pi resolves fallback models
  during session creation and prompt-time swaps through the key-requiring provider registry, so a grok-cli
  fallback must select the Grok CLI runtime up front and promote the fallback model into the CLI session.

  FNXC:GrokCliRouting 2026-07-09-23:05:
  FN-7761 closes the packaged serve/daemon/dashboard gap: if grok-cli is selected and no Fusion-visible key exists, this seam must never silently fall through to the key-requiring pi/openai-completions runtime when the Grok plugin was not pre-installed. The hosts eagerly install/load the bundled runtime; if that genuinely fails, throw an operator-actionable error naming the two supported remediations.
  */
  const autoGrokRuntimeHint = !useMockRuntime && !runtimeHint
    ? deriveGrokRuntimeHintForNoVisibleKey(runtimeOptions, pluginRunner)
    : undefined;
  const effectiveRuntimeHint = autoGrokRuntimeHint ?? runtimeHint;
  const effectiveRuntimeOptionsWithModel: AgentRuntimeOptions = autoGrokRuntimeHint
    ? applyGrokCliNoKeyRuntimeOptions(effectiveRuntimeOptions)
    : effectiveRuntimeOptions;

  const resolved = useMockRuntime
    ? {
      runtime: mockRuntimeSingleton,
      runtimeId: mockRuntimeSingleton.id,
      wasConfigured: true,
    }
    : await resolveRuntime(buildRuntimeResolutionContext(sessionPurpose, pluginRunner, effectiveRuntimeHint));

  sessionLog.log(
    `[${sessionPurpose}] Using runtime "${resolved.runtimeId}" (configured=${resolved.wasConfigured})`,
  );

  // Forward `beforeSpawnSession` to the runtime so it fires at the true
  // latest sync point (just before LLM session instantiation) rather than
  // here, before the runtime's own awaited setup work runs. See
  // AgentRuntimeOptions.beforeSpawnSession for the contract.
  //
  // FNXC:GrokAcp 2026-07-12-06:30:
  // Gate customTools for non-pi runtimes before createSession so ACP/CLI
  // bridges (e.g. Grok loopback MCP) execute already-gated closures.
  /*
  FNXC:MergeQueue 2026-07-15-11:08:
  Always forward sessionPurpose into runtime.createSession so pi host-extension policy can suppress dual-store fn_* tools on merger sessions (FN-7956 hang: wedged fn_task_show).
  */
  const sessionCreateOptions: AgentRuntimeOptions =
    shouldWrapCustomToolsForRuntime(resolved.runtimeId)
      ? {
          ...effectiveRuntimeOptionsWithModel,
          sessionPurpose,
          customTools: wrapCustomToolsForPluginRuntime(
            effectiveRuntimeOptionsWithModel.customTools,
            effectiveRuntimeOptionsWithModel,
            { runtimeId: resolved.runtimeId, sessionPurpose },
          ),
        }
      : {
          ...effectiveRuntimeOptionsWithModel,
          sessionPurpose,
        };
  const result = await resolved.runtime.createSession(sessionCreateOptions);

  const testModeActive = settings ? isTestModeActive(settings) : false;
  const mockProviderActive = isMockProviderId(runtimeOptions.defaultProvider);
  const noModelResolved = !mockProviderActive && !testModeActive && (!runtimeOptions.defaultProvider || !runtimeOptions.defaultModelId);
  const runtimeBuiltInFallbackModel = noModelResolved ? resolved.runtime.describeModel(result.session) : undefined;
  if (noModelResolved) {
    /*
    FNXC:ModelResolution 2026-07-10-00:00:
    Fusion#1984 showed that non-mock/non-test task sessions could resolve no provider+model pair and then quietly run the pi runtime's built-in default, creating unexpected spend. Keep the fallback non-fatal for existing default-model deployments, but warn and audit the actual runtime model so the drift is visible.
    */
    sessionLog.warn(
      `[${sessionPurpose}] no complete provider/model resolved; runtime "${resolved.runtimeId}" is using built-in fallback model "${runtimeBuiltInFallbackModel ?? "unknown model"}"`,
    );
  }

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
        mockProviderActive,
        testModeActive,
        ...(noModelResolved ? { noModelResolved: true, runtimeBuiltInFallbackModel } : {}),
        ...(effectiveRuntimeHint ? { runtimeHint: effectiveRuntimeHint } : {}),
        ...(autoGrokRuntimeHint ? { reason: "grok-cli-no-visible-key" } : {}),
        ...(!autoGrokRuntimeHint && "fallbackReason" in resolved && resolved.fallbackReason ? { reason: resolved.fallbackReason } : {}),
      },
    });
  } catch (err) {
    sessionLog.warn(`[${sessionPurpose}] failed to record session:runtime-resolved audit: ${String(err)}`);
  }

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
