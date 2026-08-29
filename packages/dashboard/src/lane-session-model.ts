/**
 * Shared provider/model resolution for dashboard AI helper lanes.
 *
 * FNXC:LaneModelResolution 2026-07-24-17:40:
 * `createFnAgent`/`createResolvedAgentSession` forward NO model to the runtime unless BOTH
 * `defaultProvider` and `defaultModelId` are set (`resolveConfiguredModel` in pi.ts returns
 * undefined for a half-set pair, and `createSessionWithModel` spreads the override only when
 * it is truthy). The runtime then silently picks its OWN built-in default —
 * `anthropic/claude-opus-4-8` — so a lane that resolves no pair leaves the operator's
 * configured provider entirely and issues a direct Anthropic call. For anyone without a raw
 * Anthropic API key (custom-provider, subscription, and CLI-runtime operators) that surfaces
 * as `401 invalid x-api-key` from a model they never selected. It also means `testMode`
 * cannot force such a lane onto the mock provider.
 *
 * Dashboard helper lanes (interviews, refine, translate, subtask breakdown, agent generation)
 * are planning-adjacent, so they resolve the planning lane pair — the same helper the planning
 * routes use — with test-mode overrides applied by `resolvePlanningSettingsModel` itself.
 *
 * Both halves are required: a half-set pair is treated as unset because that is exactly how
 * the runtime treats it, and pretending otherwise just moves the silent fallthrough.
 */
import { resolvePlanningSettingsModel, type TaskStore } from "@fusion/core";

export interface LaneSessionModel {
  provider?: string;
  modelId?: string;
}

/** Runtime-ready options fragment: present only when a COMPLETE pair resolved. */
export function laneModelOptions(model: LaneSessionModel): {
  defaultProvider?: string;
  defaultModelId?: string;
} {
  return model.provider && model.modelId
    ? { defaultProvider: model.provider, defaultModelId: model.modelId }
    : {};
}

/**
 * Resolve the planning-lane provider/model pair for a helper session.
 *
 * @param store - Task store to read effective settings from. Optional so callers with no
 *   store degrade to the previous behavior rather than throwing.
 * @param cached - A pair already pinned to this session (keeps a multi-turn session on one
 *   model even if settings change mid-flight, and survives agent rebuilds).
 * @param onUnresolved - Invoked when no complete pair could be resolved, so the lane can warn
 *   through its own diagnostics sink instead of failing silently onto the runtime default.
 */
export async function resolveLaneSessionModel(
  store: TaskStore | undefined,
  cached?: LaneSessionModel,
  onUnresolved?: (reason: "no-store" | "unset" | "error", error?: unknown) => void,
): Promise<LaneSessionModel> {
  if (cached?.provider && cached?.modelId) {
    return { provider: cached.provider, modelId: cached.modelId };
  }

  if (!store) {
    onUnresolved?.("no-store");
    return {};
  }

  try {
    const settings = await store.getSettings();
    const resolved = resolvePlanningSettingsModel(settings);
    if (resolved.provider && resolved.modelId) {
      return { provider: resolved.provider, modelId: resolved.modelId };
    }
    onUnresolved?.("unset");
  } catch (error) {
    onUnresolved?.("error", error);
  }

  return {};
}
