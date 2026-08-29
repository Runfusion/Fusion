/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * Models registry and usage client API peeled from legacy.ts.
 */

import { THINKING_LEVELS, type ThinkingLevel } from "@fusion/core";
import { api } from "../client/client.js";

// --- Models API ---

/** Available AI model info returned by the models endpoint */
export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  /** Ordered pi-documented levels for this model; absent means the registry did not expose capability metadata. */
  supportedThinkingLevels?: ThinkingLevel[];
  /** Provider-wide public instance metadata, attached by fetchModels for picker consumers. */
  credentialInstances?: ProviderCredentialInstanceSummary[];
}

/** Response from the models endpoint */
/** Public metadata for a configured provider credential; it never contains credential material. */
export interface ProviderCredentialInstanceSummary {
  id: string;
  isDefault: boolean;
  unavailableModelIds?: string[];
}

/**
 * Model-bound controls use exact registry capabilities when present. Older servers and CLI-discovered rows deliberately retain the canonical tuple.
 *
 * FNXC:ModelThinkingCapabilities 2026-08-18-23:38:
 * An omitted capability field is not an empty capability list: it means the server could not prove model support, so controls must keep every canonical option, including `max`, rather than fabricate an exclusion.
 */
export function getModelThinkingLevels(model: Pick<ModelInfo, "supportedThinkingLevels"> | null | undefined): readonly ThinkingLevel[] {
  return model?.supportedThinkingLevels ?? THINKING_LEVELS;
}

export interface ModelsResponse {
  models: ModelInfo[];
  favoriteProviders: string[];
  favoriteModels: string[];
  defaultProvider?: string;
  /** Configured credential instances keyed by provider, omitted by older servers. */
  providerInstances?: Record<string, { instances: ProviderCredentialInstanceSummary[] }>;
  defaultModelId?: string;
  resolvedPlanningProvider?: string;
  resolvedPlanningModelId?: string;
}

/** Fetch available AI models from the model registry along with favoriteProviders */
export async function fetchModels(): Promise<ModelsResponse> {
  const response = await api<ModelsResponse>("/models");

  /*
  FNXC:ModelDropdown 2026-08-01-09:49:
  Every existing model picker already receives the catalog returned by this client. Attach public provider-instance summaries to those rows so callers that only retain `models` still receive the optional picker availability without a parallel endpoint or a second dropdown implementation.
  */
  return {
    ...response,
    models: (response.models ?? []).map((model) => ({
      ...model,
      credentialInstances: response.providerInstances?.[model.provider]?.instances,
    })),
  };
}

// --- Usage API ---

/** Pace information for weekly usage windows */
export interface UsagePace {
  status: "ahead" | "on-track" | "behind";
  percentElapsed: number; // 0-100, how much of the window time has passed
  message: string; // e.g., "Using 15% over your limit pace"
}

/** Usage window for a provider (e.g., "Session (5h)", "Weekly") */
export interface UsageWindow {
  label: string;
  percentUsed: number; // 0-100
  percentLeft: number; // 0-100
  resetText: string | null; // e.g., "resets in 2h"
  resetMs?: number; // ms until reset
  resetAt?: string; // ISO 8601 timestamp of when the window resets (machine-readable)
  windowDurationMs?: number; // total window length
  pace?: UsagePace; // pace indicator for weekly windows
}

/** Provider usage data */
export interface ProviderUsage {
  name: string;
  icon: string; // emoji
  status: "ok" | "error" | "no-auth";
  error?: string;
  plan?: string | null;
  email?: string | null;
  windows: UsageWindow[];
}

/** Fetch usage data from all configured AI providers */
export function fetchUsageData(): Promise<{ providers: ProviderUsage[] }> {
  return api<{ providers: ProviderUsage[] }>("/usage");
}

