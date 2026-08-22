/**
 * Helper functions for creating agent sessions with runtime resolution.
 *
 * These helpers wrap the runtime resolution pattern so that subsystems
 * don't need to duplicate the resolution logic. They use the resolver
 * to select the appropriate runtime and then delegate to it for session
 * creation and prompting.
 */

import type { AgentRuntimeOptions } from "./agent-runtime.js";
import {
  createSkillsOverrideFromSelection,
  resolveProjectRoot,
  resolveSessionSkills,
  type SkillSelectionContext,
} from "../cli-runtime/skill-resolver.js";
import type { PluginRunner } from "../plugins/plugin-runner.js";
import { getAgentDir, loadSkills, type AgentSession, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  GROK_CLI_PROVIDER_ID,
  isGrokApiKeyFusionVisible,
  isTestModeActive,
  resolveAgentToolOutputMaxChars,
  resolveExecutionSettingsModel,
  resolvePermanentAgentEffectiveModel,
  resolveExecutorFallbackModel,
  resolveMergerSettingsModel,
  resolvePhaseThinkingLevel,
  resolveProjectDefaultModel,
  resolveSelectedWorkflowModelLane,
  resolveTaskExecutionModel,
  resolveTaskPlanningModel,
  resolveTaskValidatorModel,
  TEST_MODE_RESOLVED,
  toExecutionModelProviderId,
  type ResolvedModelSelection,
  type Settings,
  type ThinkingLevel,
} from "@fusion/core";
import { resolveRuntime, buildRuntimeResolutionContext, isMockProviderId, type SessionPurpose } from "../execution/runtime-resolution.js";
import { createLogger } from "../logger.js";
import {
  promptWithFallback,
  describeModel,
  wrapToolsWithActionGate,
  wrapToolsWithPermanentAgentGating,
  wrapToolsWithOutputBudget,
  wrapToolsWithRtkRewrite,
  type FallbackModelUsedPayload,
} from "../pi.js";
import * as piModuleForRegistration from "../pi.js";
import type { RunAuditor } from "../util/run-audit.js";
import { createFusionAuthStorage, resolveCredentialInstanceRef, type FusionAuthStorage } from "../auth/auth-storage.js";
import { MockAgentRuntime } from "../providers/mock-provider.js";
import {
  applyCliRuntimeOptions,
  assertExplicitCliRuntimeHint,
  deriveCliRuntimeHint,
  dropUnsupportedCliFallback,
} from "./cli-provider-routing.js";
import {
  armDeferredCrossRuntimeFallback,
  deferCrossRuntimeCliFallback,
  type DeferredCrossRuntimeFallback,
  withRuntimeEventCallbacks,
} from "./cross-runtime-fallback.js";

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
  options: Pick<AgentRuntimeOptions, "actionGateContext" | "permanentAgentGating" | "toolOutputMaxChars">,
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
  const withActionGate = wrapToolsWithActionGate(withPermanent, options.actionGateContext);
  // FNXC:ToolOutputBudget 2026-08-03-16:00:
  // Non-pi runtimes do not pass through createFnAgent, so apply the same outermost
  // setting-derived clamp here exactly once. A null budget leaves tools byte-identical.
  return wrapToolsWithOutputBudget(withActionGate, { maxChars: options.toolOutputMaxChars });
}

function wrapPluginRuntimeToolOptions(
  options: AgentRuntimeOptions,
  logContext: { runtimeId: string; sessionPurpose: string },
): Pick<AgentRuntimeOptions, "customTools" | "fusionTools"> {
  const original = options.customTools;
  const wrapped = wrapCustomToolsForPluginRuntime(original, options, logContext);
  if (!original || !wrapped) return { customTools: wrapped, fusionTools: undefined };

  const scoped = new Set(options.fusionTools ?? []);
  const fusionTools = original.flatMap((tool, index) =>
    scoped.has(tool) && tool.name.startsWith("fn_") && wrapped[index] ? [wrapped[index]] : []);
  return { customTools: wrapped, fusionTools };
}

function shouldWrapCustomToolsForRuntime(runtimeId: string): boolean {
  return !RUNTIMES_WITH_INTERNAL_TOOL_GATING.has(runtimeId);
}

/*
FNXC:RuntimeSubscribeCompat 2026-08-22-02:36:
Workflow steps consume the pi AgentSession contract and subscribe unconditionally,
while callback-only plugin runtimes use local structural session types. Normalize
that mismatch once at the shared runtime boundary so bundled and vendored runtimes
do not each need a duplicate event bridge.
*/
function createPluginSessionSubscribeCompatibility(options: AgentRuntimeOptions): {
  options: AgentRuntimeOptions;
  attach: (session: AgentSession) => void;
} {
  const subscribers = new Set<(event: unknown) => void>();
  let enabled = false;
  const emit = (event: Record<string, unknown>): void => {
    if (!enabled) return;
    for (const handler of subscribers) {
      try {
        handler(event);
      } catch {
        // FNXC:RuntimeSubscribeCompat 2026-08-22-02:36: one faulty consumer cannot break runtime streaming.
      }
    }
  };

  return {
    options: withRuntimeEventCallbacks(options, emit),
    attach: (session) => {
      const compatible = session as unknown as {
        subscribe?: (handler: (event: unknown) => void) => () => void;
      };
      if (typeof compatible.subscribe === "function") return;

      enabled = true;
      compatible.subscribe = (handler) => {
        subscribers.add(handler);
        return () => {
          subscribers.delete(handler);
        };
      };
    },
  };
}

function extractSkillNamesFromSelection(skillSelection: SkillSelectionContext | undefined): string[] {
  if (!skillSelection || !Array.isArray(skillSelection.requestedSkillNames)) {
    return [];
  }

  return skillSelection.requestedSkillNames
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
}

type SkillSummary = NonNullable<AgentRuntimeOptions["onSkillSummary"]> extends (summary: infer Summary) => unknown ? Summary : never;

function appendForcedSkillInstruction(systemPrompt: string, forcedSkillNames: string[]): string {
  if (forcedSkillNames.length === 0) return systemPrompt;
  return `${systemPrompt}\n\nBefore starting work, you are REQUIRED to read these available skills: ${forcedSkillNames.join(", ")}. All other available skills may be consulted on demand when relevant.`;
}

/*
FNXC:SkillResolution 2026-08-16-03:52:
Non-PI runtimes bypass pi.ts's DefaultResourceLoader, so this common runtime seam
resolves the same final skill set before their adapters start. Only settings-approved,
discovered forced skills are placed in the read-first instruction; unavailable intent is
reported through the summary rather than becoming an unfulfillable prompt order.
*/
function resolveNonPiSkillDelivery(options: AgentRuntimeOptions): {
  skills: string[];
  summary: SkillSummary;
} | undefined {
  if (!options.skillSelection) return undefined;

  const projectRootDir = resolveProjectRoot(options.skillSelection.projectRootDir);
  const discovered = loadSkills({
    cwd: projectRootDir,
    agentDir: getAgentDir(),
    skillPaths: options.additionalSkillPaths ?? [],
    includeDefaults: true,
  });
  const selection = resolveSessionSkills(options.skillSelection);
  const override = createSkillsOverrideFromSelection(selection, {
    requestedSkillNames: options.skillSelection.requestedSkillNames,
    forcedSkillNames: options.skillSelection.forcedSkillNames,
    sessionPurpose: options.skillSelection.sessionPurpose,
  });
  const resolved = override(discovered);
  return {
    // FNXC:SkillResolution 2026-08-16-03:52: Ensure-present role fallback/plugin
    // requests remain adapter-visible even if this process cannot discover their private body.
    skills: Array.from(new Set([
      ...resolved.skills.map((skill) => skill.name),
      ...(options.skillSelection.requestedSkillNames ?? []),
    ])),
    summary: {
      availableCount: resolved.skills.length,
      forcedSkillNames: resolved.resolvedForcedSkills.map((skill) => skill.skillName),
      unresolvedForcedSkills: resolved.unresolvedForcedSkills,
    },
  };
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
   * Runtime routing conformance injects plugin availability through `pluginRunner`.
   * The bundled Cursor adapter is executable when its plugin is registered.
   */
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
  /** Optional injected storage; only consulted when an instance was explicitly requested. */
  authStorage?: FusionAuthStorage;
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
  /** Optional runtime-owned boundary for deferred fallback callback dispatch. */
  settleFallbackDispatch?: () => Promise<void>;
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
 * Model-lane thinking overrides must resolve through the same session option (`defaultThinkingLevel`) that pi.ts already guards with the thinking/reasoning conflict fallback. Keep node/step thinking first when supplied by callers, then task, project lane, global lane, selected-workflow lane, project default thinking override, and global default.
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
export function resolveMergerThinkingLevel(
  settings: Partial<Settings> | undefined,
  taskThinkingLevel?: ThinkingLevel | string,
): string | undefined {
  return firstThinkingLevel(
    taskThinkingLevel,
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
    settings?.executionFallbackThinkingLevel,
    settings?.fallbackThinkingLevel,
    resolveSelectedWorkflowModelLane(settings, "executionFallbackThinkingLevel"),
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
    resolveSelectedWorkflowModelLane(settings, "planningFallbackThinkingLevel"),
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
    resolveSelectedWorkflowModelLane(settings, "validatorFallbackThinkingLevel"),
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
export function resolveMergerFallbackThinkingLevel(settings: Partial<Settings> | undefined, taskThinkingLevel?: string | null): string | undefined {
  return firstThinkingLevel(
    // FNXC:Settings-MergerModel 2026-07-16-00:00: A task's merger thinking selection governs both the primary and fallback merger session, so fallback must not re-inherit a project/global lane value.
    taskThinkingLevel,
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

/** The deferred Grok CLI fallback is routed through the shared cross-runtime dispatcher. */
type DeferredGrokCliFallback = DeferredCrossRuntimeFallback;

/*
FNXC:CliRuntimeRouting 2026-08-16-01:25:
Grok deliberately does not replay prior transcript text. Its historical fallback behavior is
kept byte-for-byte through the shared dispatcher; only Cursor opts into portable text context
because Cursor has no cross-runtime resume token and the new contract explicitly preserves it.
*/
function deferGrokCliFallbackForNoVisibleKey(
  runtimeOptions: AgentRuntimeOptions,
  pluginRunner: PluginRunner | undefined,
): { options: AgentRuntimeOptions; deferred?: DeferredGrokCliFallback; dropped: boolean } {
  if (runtimeOptions.defaultProvider === GROK_CLI_PROVIDER_ID
    || runtimeOptions.fallbackProvider !== GROK_CLI_PROVIDER_ID
    || isGrokApiKeyFusionVisible()) {
    return { options: runtimeOptions, dropped: false };
  }
  const options: AgentRuntimeOptions = {
    ...runtimeOptions,
    fallbackProvider: undefined,
    fallbackModelId: undefined,
    fallbackThinkingLevel: undefined,
  };
  try {
    if (!pluginRunner?.getRuntimeById("grok")) return { options, dropped: true };
  } catch {
    return { options, dropped: true };
  }
  return {
    options,
    deferred: {
      providerId: GROK_CLI_PROVIDER_ID,
      runtimeId: "grok",
      modelId: runtimeOptions.fallbackModelId?.replace(/^grok-cli\//, ""),
      thinkingLevel: runtimeOptions.fallbackThinkingLevel,
    },
    dropped: false,
  };
}

function armDeferredGrokCliFallback(args: {
  session: AgentSession & { promptWithFallback?: unknown };
  sessionPurpose: SessionPurpose;
  pluginRunner: PluginRunner | undefined;
  runAuditor: RunAuditor | undefined;
  deferred: DeferredGrokCliFallback;
  grokCreateOptions: AgentRuntimeOptions;
  primaryProvider: string | undefined;
  primaryModelId: string | undefined;
  onFallbackModelUsed: ((payload: FallbackModelUsedPayload) => Promise<void> | void) | undefined;
  taskId: string | undefined;
  taskTitle: string | undefined;
}): void {
  armDeferredCrossRuntimeFallback({
    ...args,
    createOptions: args.grokCreateOptions,
    auditEventType: "session:grok-cli-fallback-engaged",
    preserveConversationContext: false,
    engagementLabel: "grok-cli",
  });
}

function pickSettingsThenRuntimeModel(
  settingsModel: ResolvedModelSelection,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
): ResolvedModelSelection {
  // Project/task/global settings are the authoritative model hierarchy. The
  // assigned durable agent runtime model is only a final compatibility fallback
  // when the hierarchy produced no complete pair; partial runtime pairs must
  // never be mixed with settings fields or mask saved project overrides.
  if (settingsModel.provider && settingsModel.modelId) {
    return settingsModel;
  }

  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  return hasCompleteRuntimeModel(assignedRuntimeModel)
    ? assignedRuntimeModel
    : settingsModel;
}

export function resolveExecutorSessionModel(
  taskModelProvider: string | undefined,
  taskModelId: string | undefined,
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
  taskCredentialInstanceId?: string | null,
): ResolvedModelSelection {
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
      credentialInstanceId: taskCredentialInstanceId,
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
  taskCredentialInstanceId?: string | null,
): ResolvedModelSelection {
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
      planningCredentialInstanceId: taskCredentialInstanceId,
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
): ResolvedModelSelection {
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
  taskCredentialInstanceId?: string | null,
): ResolvedModelSelection {
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
      validatorCredentialInstanceId: taskCredentialInstanceId,
    },
    settings,
  );

  return pickSettingsThenRuntimeModel(resolvedTaskValidatorModel, assignedAgentRuntimeConfig);
}

export function resolveHeartbeatSessionModels(
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
  agent?: { roles?: string[]; role?: string; metadata?: Record<string, unknown> | null },
): {
  defaultProvider: string | undefined;
  defaultModelId: string | undefined;
  credentialInstanceId?: string;
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

  const executionSettingsModel = agent
    ? resolvePermanentAgentEffectiveModel(agent, settings)
    : resolveExecutionSettingsModel(settings);
  const executorFallbackModel = resolveExecutorFallbackModel(settings);
  const assignedRuntimeModel = extractRuntimeModel(assignedAgentRuntimeConfig);
  /*
  FNXC:AgentHeartbeat 2026-07-14-16:13:
  Durable-agent heartbeats must use the complete model assigned to that agent. Shared project execution defaults are only a fallback for an absent or incomplete assignment; otherwise one broken project override can park every heterogeneous agent under the same unrelated provider.
  */
  const resolvedModel: ResolvedModelSelection = hasCompleteRuntimeModel(assignedRuntimeModel)
    ? assignedRuntimeModel
    : pickSettingsThenRuntimeModel(executionSettingsModel, assignedAgentRuntimeConfig);

  return {
    defaultProvider: resolvedModel.provider,
    defaultModelId: resolvedModel.modelId,
    ...(resolvedModel.credentialInstanceId ? { credentialInstanceId: resolvedModel.credentialInstanceId } : {}),
    fallbackProvider: executorFallbackModel.provider,
    fallbackModelId: executorFallbackModel.modelId,
  };
}

export function resolveMergerSessionModel(
  settings: Partial<Settings> | undefined,
  assignedAgentRuntimeConfig?: Record<string, unknown>,
  task?: { mergerModelProvider?: string | null; mergerModelId?: string | null; mergerCredentialInstanceId?: string | null },
): ResolvedModelSelection {
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
  /* FNXC:Settings-MergerModel 2026-07-16-12:00: task pair → settings → global/default; partial task pairs inherit settings. */
  const mergerModel = task?.mergerModelProvider && task?.mergerModelId
    ? { provider: task.mergerModelProvider, modelId: task.mergerModelId, credentialInstanceId: task.mergerCredentialInstanceId ?? undefined }
    : resolveMergerSettingsModel(settings);
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
  const { sessionPurpose, pluginRunner, runtimeHint, runAuditor, settings, authStorage: injectedAuthStorage, credentialInstanceId: requestedCredentialInstanceId, ...runtimeOptionsRaw } = options;
  /*
  FNXC:ProviderAuth 2026-08-15-20:57:
  This shared session seam receives persisted task, lane, and agent selections from every runtime. Convert Anthropic auth-card ids before credential-instance lookup and runtime creation, so pi-ai receives only `anthropic` while Fusion auth storage still resolves its subscription material through that execution id.
  */
  const executionRuntimeOptions = {
    ...runtimeOptionsRaw,
    ...(runtimeOptionsRaw.defaultProvider ? { defaultProvider: toExecutionModelProviderId(runtimeOptionsRaw.defaultProvider) } : {}),
    ...(runtimeOptionsRaw.fallbackProvider ? { fallbackProvider: toExecutionModelProviderId(runtimeOptionsRaw.fallbackProvider) } : {}),
  };
  let credentialResolution: ReturnType<typeof resolveCredentialInstanceRef> | undefined;
  if (requestedCredentialInstanceId) {
    try {
      const storage = injectedAuthStorage ?? createFusionAuthStorage();
      credentialResolution = resolveCredentialInstanceRef(storage, executionRuntimeOptions.defaultProvider ?? "", requestedCredentialInstanceId);
    } catch (error) {
      /*
      FNXC:ProviderAuth 2026-08-03-17:35:
      CredentialInstanceResolutionError used to hard-fail the lane. Chat never passes a
      credentialInstanceId and succeeds via customProviders.apiKey registration; executor
      previously synthesized "default" and died when auth.json had no bare/default instance
      for that provider (custom providers, renames). Self-heal: drop the scoped selection and
      continue on the legacy unscoped path so the session matches chat. Still warn for audit.
      Other resolution errors remain soft as before.
      */
      if ((error as Error).name === "CredentialInstanceResolutionError") {
        sessionLog.warn(
          `[${sessionPurpose}] credential instance "${requestedCredentialInstanceId}" for provider "${executionRuntimeOptions.defaultProvider ?? ""}" unresolved; continuing with legacy provider auth (custom provider apiKey / unscoped default)`,
        );
      } else {
        sessionLog.warn(`[${sessionPurpose}] credential instance resolution unavailable; using provider default`);
      }
    }
  }

  /*
  FNXC:ProviderAuth 2026-08-01-08:10:
  A dangling named instance must be auditable: silent substitution spends the wrong account quota under an identity the operator did not select.

  FNXC:ProviderAuth 2026-08-03-17:35:
  renamedProvider is the auth-key slug self-heal (custom provider rename left credentials under the previous registry key).
  */
  if (credentialResolution?.missing) {
    sessionLog.warn(
      credentialResolution.renamedProvider
        ? `[${sessionPurpose}] requested credential instance is missing; self-healed via renamed provider default "${credentialResolution.ref.providerId}/${credentialResolution.ref.instanceId}"`
        : `[${sessionPurpose}] requested credential instance is missing; using provider default`,
    );
  }

  const skillNamesFromSelection = extractSkillNamesFromSelection(executionRuntimeOptions.skillSelection);
  const mergedSkillNames = executionRuntimeOptions.skills && executionRuntimeOptions.skills.length > 0
    ? executionRuntimeOptions.skills
    : skillNamesFromSelection;

  /*
  FNXC:ChatSkills 2026-07-20-10:30:
  createResolvedAgentSession must preserve additionalSkillPaths into runtime.createSession.
  Plugin skill names alone never deliver bodies; chat, step, and cron lanes require both halves of the #2017 contract (FN-8443 / #2364).
  */
  /*
  FNXC:ToolOutputBudget 2026-08-03-16:00:
  Resolve the merged settings once at this all-lanes seam. A caller can still provide
  an explicit runtime value (including null for unlimited); otherwise settings supply
  the finite default, custom cap, or explicit no-limit sentinel interpretation.
  */
  const runtimeOptions: AgentRuntimeOptions = {
    ...executionRuntimeOptions,
    toolOutputMaxChars: executionRuntimeOptions.toolOutputMaxChars !== undefined
      ? executionRuntimeOptions.toolOutputMaxChars
      : resolveAgentToolOutputMaxChars(settings ?? {}),
    ...(mergedSkillNames.length > 0 ? { skills: mergedSkillNames } : {}),
    ...(credentialResolution ? {
      resolvedCredentialInstance: credentialResolution.ref,
      credentialInstanceId: credentialResolution.requestedInstanceId,
    } : {}),
  };
  // FNXC:McpConfig 2026-06-25-22:06:
  // createResolvedAgentSession is the common lane helper for executor, reviewer, validator, workflow model-node, summarization, and merger-adjacent paths that pass MCP through this seam. Preserve `mcpServers` verbatim here; runtime-resolution/pi own support-gated forwarding and content-free skip logging.

  const testModeActive = settings ? isTestModeActive(settings) : false;
  const mockProviderActive = isMockProviderId(runtimeOptions.defaultProvider);
  const useMockRuntime = mockProviderActive || testModeActive;
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

  FNXC:GrokCliRouting 2026-07-22-14:30:
  FN-7758's fallback-promotion behavior is removed: a configured grok-cli FALLBACK no longer selects the
  Grok CLI runtime or replaces the primary model up front. That promotion silently discarded a healthy
  configured primary (planning ran grok-4.5 instead of the configured gpt-5.6-sol on every session).
  Fallback-only grok-cli selections without a visible key now keep the primary on its own runtime and
  drop the unusable fallback pair with a warning + audit flag (see dropGrokCliFallbackForNoVisibleKey).

  FNXC:GrokCliRouting 2026-07-09-23:05:
  FN-7761 closes the packaged serve/daemon/dashboard gap: if grok-cli is selected and no Fusion-visible key exists, this seam must never silently fall through to the key-requiring pi/openai-completions runtime when the Grok plugin was not pre-installed. The hosts eagerly install/load the bundled runtime; if that genuinely fails, throw an operator-actionable error naming the two supported remediations.
  */
  const autoCliRuntimeHint = !useMockRuntime && !runtimeHint
    ? deriveCliRuntimeHint({
      runtimeOptions,
      pluginRunner,
      grokApiKeyVisible: isGrokApiKeyFusionVisible(),
    })
    : undefined;
  const effectiveRuntimeHint = autoCliRuntimeHint ?? runtimeHint;
  if (!useMockRuntime) {
    // Explicit CLI hints with assert-available policy must pre-empt resolveRuntime's pi fallback.
    assertExplicitCliRuntimeHint({ runtimeHint, runtimeOptions, pluginRunner });
  }
  const usesAutoGrokRuntime = autoCliRuntimeHint === "grok" && runtimeOptions.defaultProvider === GROK_CLI_PROVIDER_ID;
  /*
  FNXC:GrokCliRouting 2026-07-22-15:10:
  When only the fallback is grok-cli with no visible key (and the session is not explicitly
  hinted onto the Grok runtime), withhold the pair from the primary runtime and arm a
  prompt-time swap to the Grok CLI runtime instead of preempting the configured primary.
  */
  const grokFallbackDeferral = !useMockRuntime && !usesAutoGrokRuntime && effectiveRuntimeHint !== "grok"
    ? deferGrokCliFallbackForNoVisibleKey(effectiveRuntimeOptions, pluginRunner)
    : { options: effectiveRuntimeOptions, dropped: false as const };
  const crossRuntimeFallbackDeferral = !useMockRuntime && !("deferred" in grokFallbackDeferral)
    && effectiveRuntimeHint !== "cursor"
    ? deferCrossRuntimeCliFallback(grokFallbackDeferral.options, pluginRunner)
    : { options: grokFallbackDeferral.options, dropped: false as const };
  const droppedCliFallback = dropUnsupportedCliFallback(crossRuntimeFallbackDeferral.options);
  const effectiveRuntimeOptionsWithModel = applyCliRuntimeOptions(
    droppedCliFallback.options,
    effectiveRuntimeHint,
  );
  const deferredGrokFallback = "deferred" in grokFallbackDeferral ? grokFallbackDeferral.deferred : undefined;
  const deferredCrossRuntimeFallback = "deferred" in crossRuntimeFallbackDeferral
    ? crossRuntimeFallbackDeferral.deferred
    : undefined;
  if (droppedCliFallback.droppedProvider) {
    sessionLog.warn(
      `[${sessionPurpose}] configured ${droppedCliFallback.droppedProvider} fallback "${runtimeOptions.fallbackModelId ?? "unknown"}" dropped: primary "${runtimeOptions.defaultProvider}/${runtimeOptions.defaultModelId}" is unchanged because the fallback requires its own CLI runtime.`,
    );
  } else if (grokFallbackDeferral.dropped) {
    sessionLog.warn(
      `[${sessionPurpose}] configured grok-cli fallback "${runtimeOptions.fallbackModelId ?? "unknown"}" dropped: no Fusion-visible GROK_API_KEY and the Grok CLI runtime plugin is unavailable; primary "${runtimeOptions.defaultProvider}/${runtimeOptions.defaultModelId}" is unchanged. Install/enable the Grok CLI runtime plugin or set GROK_API_KEY.`,
    );
  } else if (crossRuntimeFallbackDeferral.dropped) {
    sessionLog.warn(
      `[${sessionPurpose}] configured ${runtimeOptions.fallbackProvider ?? "cross-runtime"} fallback "${runtimeOptions.fallbackModelId ?? "unknown"}" dropped: its runtime plugin is unavailable; primary "${runtimeOptions.defaultProvider}/${runtimeOptions.defaultModelId}" is unchanged.`,
    );
  } else if (deferredCrossRuntimeFallback) {
    sessionLog.debug(
      `[${sessionPurpose}] ${deferredCrossRuntimeFallback.providerId} fallback "${deferredCrossRuntimeFallback.modelId ?? "unknown"}" deferred to the ${deferredCrossRuntimeFallback.runtimeId} runtime: it engages only if primary "${runtimeOptions.defaultProvider}/${runtimeOptions.defaultModelId}" fails with a retryable model error.`,
    );
  } else if (deferredGrokFallback) {
    /*
    FNXC:EngineDiagnostics 2026-08-01-18:11:
    Deferred grok-cli fallback is the expected no-visible-key config path and fires on every
    session create. Real engagement already warns + audits `session:grok-cli-fallback-engaged`;
    keep the deferral notice on debug (FUSION_DEBUG=agent-session) so the TUI is not flooded.
    */
    sessionLog.debug(
      `[${sessionPurpose}] grok-cli fallback "${deferredGrokFallback.modelId ?? "unknown"}" deferred to the Grok CLI runtime: it engages only if primary "${runtimeOptions.defaultProvider}/${runtimeOptions.defaultModelId}" fails with a retryable model error.`,
    );
  }

  const resolved = useMockRuntime
    ? {
      runtime: mockRuntimeSingleton,
      runtimeId: mockRuntimeSingleton.id,
      wasConfigured: true,
    }
    : await resolveRuntime(buildRuntimeResolutionContext(sessionPurpose, pluginRunner, effectiveRuntimeHint));

  /*
  FNXC:EngineDiagnostics 2026-08-01-18:11:
  Runtime resolution is per-session setup chatter (same class as demoted planning `using model`).
  Audit already records `session:runtime-resolved`; keep the TUI line on debug (FUSION_DEBUG=agent-session).
  */
  sessionLog.debug(
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
  const nonPiSkillDelivery = resolved.runtimeId === "pi"
    ? undefined
    : resolveNonPiSkillDelivery(effectiveRuntimeOptionsWithModel);
  const baseSessionCreateOptions: AgentRuntimeOptions = nonPiSkillDelivery
    ? {
        ...effectiveRuntimeOptionsWithModel,
        // Non-PI adapters receive the final availability set, never raw forced intent.
        skills: nonPiSkillDelivery.skills,
        systemPrompt: appendForcedSkillInstruction(
          effectiveRuntimeOptionsWithModel.systemPrompt,
          nonPiSkillDelivery.summary.forcedSkillNames,
        ),
        ...(effectiveRuntimeOptionsWithModel.systemPromptLayers ? {
          systemPromptLayers: {
            ...effectiveRuntimeOptionsWithModel.systemPromptLayers,
            dynamic: appendForcedSkillInstruction(
              effectiveRuntimeOptionsWithModel.systemPromptLayers.dynamic,
              nonPiSkillDelivery.summary.forcedSkillNames,
            ),
          },
        } : {}),
      }
    : effectiveRuntimeOptionsWithModel;
  if (nonPiSkillDelivery) await baseSessionCreateOptions.onSkillSummary?.(nonPiSkillDelivery.summary);
  const sessionCreateOptions: AgentRuntimeOptions =
    shouldWrapCustomToolsForRuntime(resolved.runtimeId)
      ? {
          ...baseSessionCreateOptions,
          sessionPurpose,
          ...wrapPluginRuntimeToolOptions(baseSessionCreateOptions, { runtimeId: resolved.runtimeId, sessionPurpose }),
        }
      : {
          ...baseSessionCreateOptions,
          sessionPurpose,
        };
  const subscribeCompatibility = resolved.runtimeId === "pi"
    ? undefined
    : createPluginSessionSubscribeCompatibility(sessionCreateOptions);
  const result = await resolved.runtime.createSession(
    subscribeCompatibility?.options ?? sessionCreateOptions,
  );
  subscribeCompatibility?.attach(result.session);

  const noModelResolved = !mockProviderActive && !testModeActive && (!runtimeOptions.defaultProvider || !runtimeOptions.defaultModelId);
  const runtimeBuiltInFallbackModel = noModelResolved ? resolved.runtime.describeModel(result.session) : undefined;
  const fusionToolBridgeError = (result.session as { fusionToolBridgeError?: { reasonCode?: unknown } }).fusionToolBridgeError;
  const fusionToolBridgeReasonCode = fusionToolBridgeError?.reasonCode === "mcp-schema-server-missing"
    || fusionToolBridgeError?.reasonCode === "bridge-start-failed"
    ? fusionToolBridgeError.reasonCode
    : undefined;
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
        /*
        FNXC:ModelResolution 2026-07-22-14:30:
        Audit the POST-transform pair the session actually runs, not the pre-transform
        configuration. The old pre-transform values masked the FN-7758 fallback promotion:
        run-audit claimed planning used the configured primary while the session ran the
        promoted grok fallback.
        */
        provider: effectiveRuntimeOptionsWithModel.defaultProvider ?? null,
        modelId: effectiveRuntimeOptionsWithModel.defaultModelId ?? null,
        mockProviderActive,
        testModeActive,
        ...(grokFallbackDeferral.dropped ? { grokCliFallbackDropped: true } : {}),
        ...(deferredGrokFallback ? { grokCliFallbackDeferred: true } : {}),
        ...(crossRuntimeFallbackDeferral.dropped ? { crossRuntimeFallbackDropped: true } : {}),
        ...(deferredCrossRuntimeFallback ? { crossRuntimeFallbackDeferred: true } : {}),
        ...(noModelResolved ? { noModelResolved: true, runtimeBuiltInFallbackModel } : {}),
        ...(credentialResolution?.ref.instanceId ? { credentialInstanceId: credentialResolution.ref.instanceId } : {}),
        ...(credentialResolution?.missing ? {
          credentialInstanceMissing: true,
          requestedCredentialInstanceId: credentialResolution.requestedInstanceId,
          resolvedCredentialInstanceId: credentialResolution.ref.instanceId,
        } : {}),
        /*
        FNXC:FusionToolBridgeDiagnostics 2026-07-20-08:00:
        Plugin bridge failures are session-visible, but they also need one durable
        engine signal. Record only fixed reason codes and requested counts here;
        tool schemas, paths, error prose, and credentials must never enter run-audit.
        */
        ...(fusionToolBridgeReasonCode
          ? {
              fusionToolBridgeFailed: true,
              fusionToolBridgeReasonCode,
              expectedToolCount: Array.isArray(effectiveRuntimeOptionsWithModel.customTools)
                ? effectiveRuntimeOptionsWithModel.customTools.length
                : 0,
            }
          : {}),
        ...(effectiveRuntimeHint ? { runtimeHint: effectiveRuntimeHint } : {}),
        ...(autoCliRuntimeHint === "grok" ? { reason: "grok-cli-no-visible-key" } : {}),
        ...(autoCliRuntimeHint === "omp" ? { reason: "omp-cli-runtime" } : {}),
        ...(grokFallbackDeferral.dropped ? { reason: "grok-cli-fallback-dropped-no-visible-key" } : {}),
        ...(deferredGrokFallback ? { reason: "grok-cli-fallback-deferred-no-visible-key" } : {}),
        ...(crossRuntimeFallbackDeferral.dropped ? { reason: "cross-runtime-fallback-dropped-runtime-unavailable" } : {}),
        ...(deferredCrossRuntimeFallback ? { reason: "cross-runtime-fallback-deferred" } : {}),
        ...(!autoCliRuntimeHint && !grokFallbackDeferral.dropped && !deferredGrokFallback && !crossRuntimeFallbackDeferral.dropped && !deferredCrossRuntimeFallback && "fallbackReason" in resolved && resolved.fallbackReason ? { reason: resolved.fallbackReason } : {}),
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

  /*
  FNXC:GrokCliRouting 2026-07-22-15:10:
  Deferred grok-cli fallback engagement. The primary session runs with NO in-runtime
  fallback (the pair was withheld above), so a retryable model failure surfaces here as a
  thrown error instead of pi's in-session swap. On the first such failure, create a fresh
  session on the Grok CLI runtime with the deferred fallback model and re-issue the failed
  prompt there; all subsequent prompts stay on the Grok CLI session. Conversation state
  from turns completed on the primary before the swap is not replayed — same limitation
  as a lane-level retry — so the swap logs and audits itself for visibility.
  Non-retryable errors propagate unchanged; the swap happens at most once.
  */
  if (deferredGrokFallback) {
    const grokBaseOptions: AgentRuntimeOptions = {
      ...effectiveRuntimeOptionsWithModel,
      sessionPurpose,
      defaultProvider: GROK_CLI_PROVIDER_ID,
      defaultModelId: deferredGrokFallback.modelId,
      defaultThinkingLevel: deferredGrokFallback.thinkingLevel ?? effectiveRuntimeOptionsWithModel.defaultThinkingLevel,
    };
    armDeferredGrokCliFallback({
      session,
      sessionPurpose,
      pluginRunner,
      runAuditor,
      deferred: deferredGrokFallback,
      grokCreateOptions: shouldWrapCustomToolsForRuntime("grok")
        ? {
            ...grokBaseOptions,
            ...wrapPluginRuntimeToolOptions(grokBaseOptions, { runtimeId: "grok", sessionPurpose }),
          }
        : grokBaseOptions,
      primaryProvider: runtimeOptions.defaultProvider,
      primaryModelId: runtimeOptions.defaultModelId,
      onFallbackModelUsed: runtimeOptions.onFallbackModelUsed,
      taskId: runtimeOptions.taskId,
      taskTitle: runtimeOptions.taskTitle,
    });
  }

  if (deferredCrossRuntimeFallback) {
    const fallbackBaseOptions: AgentRuntimeOptions = {
      ...effectiveRuntimeOptionsWithModel,
      sessionPurpose,
      defaultProvider: deferredCrossRuntimeFallback.providerId,
      defaultModelId: deferredCrossRuntimeFallback.modelId,
      defaultThinkingLevel: deferredCrossRuntimeFallback.thinkingLevel ?? effectiveRuntimeOptionsWithModel.defaultThinkingLevel,
    };
    armDeferredCrossRuntimeFallback({
      session,
      sessionPurpose,
      pluginRunner,
      runAuditor,
      deferred: deferredCrossRuntimeFallback,
      createOptions: shouldWrapCustomToolsForRuntime(deferredCrossRuntimeFallback.runtimeId)
        ? {
            ...fallbackBaseOptions,
            ...wrapPluginRuntimeToolOptions(fallbackBaseOptions, { runtimeId: deferredCrossRuntimeFallback.runtimeId, sessionPurpose }),
          }
        : fallbackBaseOptions,
      primaryProvider: runtimeOptions.defaultProvider,
      primaryModelId: runtimeOptions.defaultModelId,
      onFallbackModelUsed: runtimeOptions.onFallbackModelUsed,
      taskId: runtimeOptions.taskId,
      taskTitle: runtimeOptions.taskTitle,
      auditEventType: "session:cross-runtime-fallback-engaged",
      preserveConversationContext: true,
    });
  }

  return {
    session: result.session,
    sessionFile: result.sessionFile,
    settleFallbackDispatch: result.settleFallbackDispatch,
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

/*
FNXC:CliRuntimeRouting 2026-08-16-14:37:
Register this module's createResolvedAgentSession as pi.ts's routed session
factory so bare `createFnAgent` callers get CLI runtime routing (cursor/claude/
grok/omp/hermes), mock forcing, and runtime-resolved visibility without every
lane importing the seam. Late-binding registration (mirrors core's
setCreateFnAgent) instead of a static pi.ts -> agent-session-helpers import,
which would create an eval-order-sensitive cycle (this module and
runtime-resolution both import pi.ts). Runs once at module load; any host that
loads @fusion/engine's index (all real hosts) gets it.

Namespace access + try/catch on purpose: dozens of engine tests replace
"../pi.js" with pure vi.mock factories that predate this export, and vitest's
mock proxy THROWS on access to a missing export. Under such mocks the
registration is skipped and their mocked createFnAgent behaves as before.
*/
try {
  (piModuleForRegistration as { registerRoutedAgentSessionFactory?: (factory: (options: Record<string, unknown>) => Promise<import("../pi.js").AgentResult>) => void })
    .registerRoutedAgentSessionFactory?.(
      createResolvedAgentSession as unknown as (options: Record<string, unknown>) => Promise<import("../pi.js").AgentResult>,
    );
} catch {
  // Mocked pi.js without the export: leave createFnAgent on its raw fallback.
}
