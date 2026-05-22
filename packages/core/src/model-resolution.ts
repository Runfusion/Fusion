import type { Settings } from "./types.js";

export interface ResolvedModelSelection {
  provider?: string;
  modelId?: string;
}

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
