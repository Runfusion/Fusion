import { isExperimentalFeatureEnabled } from "../config/experimental-features.js";
import { resolveValidatorSettingsModel } from "../ai/model-resolution.js";
import type { ResolvedEvalSettings, Settings } from "../types.js";

const DEFAULT_EVAL_SETTINGS: Omit<ResolvedEvalSettings, "evaluatorProvider" | "evaluatorModelId"> = {
  enabled: false,
  intervalMs: 86_400_000,
  followUpPolicy: "suggest-only",
  retentionDays: 30,
};

export function isEvalsExperimentalEnabled(settings: Partial<Settings> | undefined): boolean {
  return isExperimentalFeatureEnabled(settings, "evalsView");
}

export function resolveEvalSettings(settings: Partial<Settings> | undefined): ResolvedEvalSettings {
  const scopedSettings = settings?.evalSettings;
  const validatorModel = resolveValidatorSettingsModel(settings);

  return {
    enabled: scopedSettings?.enabled ?? DEFAULT_EVAL_SETTINGS.enabled,
    intervalMs: scopedSettings?.intervalMs ?? DEFAULT_EVAL_SETTINGS.intervalMs,
    evaluatorProvider: scopedSettings?.evaluatorProvider ?? validatorModel.provider,
    evaluatorModelId: scopedSettings?.evaluatorModelId ?? validatorModel.modelId,
    followUpPolicy: scopedSettings?.followUpPolicy ?? DEFAULT_EVAL_SETTINGS.followUpPolicy,
    retentionDays: scopedSettings?.retentionDays ?? DEFAULT_EVAL_SETTINGS.retentionDays,
  };
}
