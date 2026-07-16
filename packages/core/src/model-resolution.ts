import type { Settings, ThinkingLevel } from "./types.js";
import type {
  ModelGovernancePredicate,
  RouterDecision,
  RouterLane,
  RouterTaskContext,
} from "./model-router.js";
import { routeModel } from "./model-router.js";

export interface ResolvedModelSelection {
  provider?: string;
  modelId?: string;
}

export type ModelThinkingPhase = "execution" | "planning" | "validation";

export const TEST_MODE_RESOLVED: ResolvedModelSelection = { provider: "mock", modelId: "scripted" };

export function isTestModeActive(settings?: Partial<Settings>): boolean {
  return settings?.testMode === true || settings?.defaultProvider?.trim().toLowerCase() === "mock";
}

export function applyTestModeOverrides(
  resolved: ResolvedModelSelection,
  settings?: Partial<Settings>,
): ResolvedModelSelection {
  return isTestModeActive(settings) ? TEST_MODE_RESOLVED : resolved;
}

type ModelPair =
  | ResolvedModelSelection
  | {
      provider?: string | null;
      modelId?: string | null;
    }
  | undefined;

type TaskModelLike = {
  modelProvider?: string | null;
  modelId?: string | null;
  validatorModelProvider?: string | null;
  validatorModelId?: string | null;
  planningModelProvider?: string | null;
  planningModelId?: string | null;
};

function hasCompleteModelPair(pair: ModelPair): pair is { provider: string; modelId: string } {
  return Boolean(pair?.provider && pair?.modelId);
}

function pickFirstModelPair(...pairs: ModelPair[]): ResolvedModelSelection {
  for (const pair of pairs) {
    if (hasCompleteModelPair(pair)) {
      return { provider: pair.provider, modelId: pair.modelId };
    }
  }
  return {};
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
 * Workflow model-lane thinking companions are workflow-declared settings whose unset state means inherit. Resolve them centrally so executor, reviewer, triage, step sessions, and merger-adjacent validation agree on precedence: node/step override > task thinking > workflow lane > global lane > project default thinking override > global default thinking level.
 */
export function resolveSettingsLaneThinkingLevel(
  phase: ModelThinkingPhase,
  settings?: Partial<Settings>,
): ThinkingLevel | undefined {
  if (phase === "execution") return settings?.executionThinkingLevel;
  if (phase === "planning") return settings?.planningThinkingLevel;
  return settings?.validatorThinkingLevel;
}

export function resolvePhaseThinkingLevel(
  phase: ModelThinkingPhase,
  settings: Partial<Settings> | undefined,
  nodeOrTaskThinkingLevel?: ThinkingLevel | string,
): string | undefined {
  const globalLane = phase === "execution"
    ? settings?.executionGlobalThinkingLevel
    : phase === "planning"
      ? settings?.planningGlobalThinkingLevel
      : settings?.validatorGlobalThinkingLevel;
  return firstThinkingLevel(
    nodeOrTaskThinkingLevel,
    resolveSettingsLaneThinkingLevel(phase, settings),
    globalLane,
    settings?.defaultThinkingLevelOverride,
    settings?.defaultThinkingLevel,
  );
}

export function resolveProjectDefaultModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.defaultProviderOverride,
        modelId: settings?.defaultModelIdOverride,
      },
      {
        provider: settings?.defaultProvider,
        modelId: settings?.defaultModelId,
      },
    ),
    settings,
  );
}

export function resolveExecutionSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.executionProvider,
        modelId: settings?.executionModelId,
      },
      {
        provider: settings?.executionGlobalProvider,
        modelId: settings?.executionGlobalModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

export function resolvePlanningSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.planningProvider,
        modelId: settings?.planningModelId,
      },
      {
        provider: settings?.planningGlobalProvider,
        modelId: settings?.planningGlobalModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

export function resolveValidatorSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.validatorProvider,
        modelId: settings?.validatorModelId,
      },
      {
        provider: settings?.validatorGlobalProvider,
        modelId: settings?.validatorGlobalModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

export function resolveTitleSummarizerSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.titleSummarizerProvider,
        modelId: settings?.titleSummarizerModelId,
      },
      {
        provider: settings?.titleSummarizerGlobalProvider,
        modelId: settings?.titleSummarizerGlobalModelId,
      },
      {
        provider: settings?.planningProvider,
        modelId: settings?.planningModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

/*
FNXC:GitHubImportTranslate 2026-07-15-09:30:
Import auto-translation resolves its own lane so operators can pin a cheap/fast translation model independently of summarization.
Hierarchy: project translate lane -> global translate lane -> summarization lane (nearest one-off readonly helper) -> project/global default.
Partial provider/model pairs are skipped by `pickFirstModelPair`, and test mode still forces mock like every other lane.
*/
export function resolveImportTranslateSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.importTranslateProvider,
        modelId: settings?.importTranslateModelId,
      },
      {
        provider: settings?.importTranslateGlobalProvider,
        modelId: settings?.importTranslateGlobalModelId,
      },
      {
        provider: settings?.titleSummarizerProvider,
        modelId: settings?.titleSummarizerModelId,
      },
      {
        provider: settings?.titleSummarizerGlobalProvider,
        modelId: settings?.titleSummarizerGlobalModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

/**
 * FNXC:Settings-MergerModel 2026-07-13-07:52:
 * Merger sessions resolve project merger lane → global merger lane → project/global default.
 * They intentionally do not inherit execution/planning/validator lanes so a merge-specific
 * model can be configured under Global/Project Models without changing other AI roles.
 */
export function resolveMergerSettingsModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.mergerProvider,
        modelId: settings?.mergerModelId,
      },
      {
        provider: settings?.mergerGlobalProvider,
        modelId: settings?.mergerGlobalModelId,
      },
      resolveProjectDefaultModel(settings),
    ),
    settings,
  );
}

/**
 * FNXC:Settings-MergerModel 2026-07-16-00:00:
 * Retryable merger sessions resolve a project merger-fallback pair before the shared
 * global fallback pair. Complete-pair selection and test-mode override behavior match
 * all other model lanes, preserving existing behavior while this lane is unset.
 */
export function resolveMergerFallbackModel(settings?: Partial<Settings>): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: settings?.mergerFallbackProvider,
        modelId: settings?.mergerFallbackModelId,
      },
      {
        provider: settings?.fallbackProvider,
        modelId: settings?.fallbackModelId,
      },
    ),
    settings,
  );
}

export function resolveTaskExecutionModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: task.modelProvider,
        modelId: task.modelId,
      },
      resolveExecutionSettingsModel(settings),
    ),
    settings,
  );
}

export function resolveTaskValidatorModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: task.validatorModelProvider,
        modelId: task.validatorModelId,
      },
      resolveValidatorSettingsModel(settings),
    ),
    settings,
  );
}

export function resolveTaskPlanningModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
): ResolvedModelSelection {
  return applyTestModeOverrides(
    pickFirstModelPair(
      {
        provider: task.planningModelProvider,
        modelId: task.planningModelId,
      },
      resolvePlanningSettingsModel(settings),
    ),
    settings,
  );
}

// ── Fusion Model Router lane wrappers (U17 / KTD9) ─────────────────────────
//
// These are the **governed** session-start lanes: execution, planning, and
// validation. Each first resolves the lane's default pair exactly as today (the
// router's counterfactual), then hands it to the selection layer. The router is
// OFF by default — when disabled it returns the default pair byte-identically,
// so these wrappers are safe drop-ins. The non-routed resolvers above remain
// untouched; the settings-only resolvers, `resolveProjectDefaultModel`, and
// `resolveTitleSummarizerSettingsModel` are **ungoverned** (no task signal /
// non-session purpose) and the router never touches them.

/** Options shared by the router-aware lane resolvers. */
export interface RouterLaneOptions {
  /** Per-task per-lane override pair (e.g. a column-agent binding). When complete,
   *  the router defers to it. */
  overridePair?: ResolvedModelSelection | null;
  /** Classification signal for the conservative v0 allowlist. */
  context?: RouterTaskContext;
  /** Governance gate — the router never returns a pair this rejects. */
  isPermitted?: ModelGovernancePredicate;
}

function routeLane(
  lane: RouterLane,
  defaultPair: ResolvedModelSelection,
  settings: Partial<Settings> | undefined,
  options: RouterLaneOptions | undefined,
): RouterDecision {
  return routeModel({
    lane,
    defaultPair,
    overridePair: options?.overridePair ?? null,
    context: options?.context,
    settings,
    isPermitted: options?.isPermitted,
  });
}

/**
 * Router-aware execution-lane resolution. Returns the full {@link RouterDecision}
 * (selection + counterfactual + reason) so the caller can emit telemetry and wire
 * the escalation seam. With the router disabled, `decision.selection` equals
 * {@link resolveTaskExecutionModel}.
 */
export function routeTaskExecutionModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
  options?: RouterLaneOptions,
): RouterDecision {
  return routeLane("execution", resolveTaskExecutionModel(task, settings), settings, options);
}

/** Router-aware planning-lane resolution. See {@link routeTaskExecutionModel}. */
export function routeTaskPlanningModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
  options?: RouterLaneOptions,
): RouterDecision {
  return routeLane("planning", resolveTaskPlanningModel(task, settings), settings, options);
}

/** Router-aware validation-lane resolution. See {@link routeTaskExecutionModel}. */
export function routeTaskValidatorModel(
  task: TaskModelLike,
  settings?: Partial<Settings>,
  options?: RouterLaneOptions,
): RouterDecision {
  return routeLane("validation", resolveTaskValidatorModel(task, settings), settings, options);
}
