/**
 * Thinking effort configuration for mapping pi's ThinkingLevel to Droid CLI --effort flags.
 *
 * Maps pi's reasoning levels (minimal/low/medium/high/xhigh/max) to the CLI's effort
 * levels (low/medium/high/max). Opus models get an elevated mapping where medium
 * becomes high and high becomes max, leveraging their superior reasoning capability.
 *
 * FNXC:DroidThinking 2026-07-16-18:20:
 * Fusion now resolves pi 0.81.1 workspace-wide, whose ThinkingLevel includes `max`.
 * Keep both exhaustive mappings explicit: non-Opus must still avoid the CLI's max
 * effort, while Opus may use it.
 *
 * IMPORTANT: The CLI does NOT support --thinking-budget. Only --effort is supported.
 */

import type { ThinkingLevel, ThinkingBudgets } from "@earendil-works/pi-ai";

/** CLI effort levels accepted by the --effort flag */
export type CliEffortLevel = "low" | "medium" | "high" | "max";

/**
 * Standard model mapping: pi ThinkingLevel -> CLI effort.
 * Non-Opus models never receive "max" (would cause CLI error).
 */
const STANDARD_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high", // non-Opus: silently downgrade (max not supported)
  max: "high", // non-Opus: silently downgrade (max not supported)
};

/**
 * Opus model mapping: shifted up for elevated reasoning.
 * Opus models get max capability at high/xhigh levels.
 */
const OPUS_EFFORT_MAP: Record<ThinkingLevel, CliEffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "high", // shifted: standard high
  high: "max", // shifted: maximum capability
  xhigh: "max", // Opus gets max
  max: "max", // Opus gets max
};

/**
 * Detect whether a model ID refers to an Opus model.
 * Uses includes('opus') for forward-compatibility with future Opus versions.
 *
 * @param modelId - The model identifier string
 * @returns true if the model is an Opus variant
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes("opus");
}

/**
 * Map pi's ThinkingLevel to a CLI effort string.
 *
 * When reasoning is undefined, returns undefined so the --effort flag is omitted
 * entirely, letting the CLI use its default behavior. When thinkingBudgets are
 * provided, a console.warn is logged because the CLI only supports effort levels,
 * not token budgets.
 *
 * @param reasoning - Pi's thinking level (undefined = omit flag)
 * @param modelId - Model ID for Opus detection
 * @param thinkingBudgets - Custom budgets (logged as unsupported, not applied)
 * @returns CLI effort level string, or undefined if flag should be omitted
 */
export function mapThinkingEffort(
  reasoning?: ThinkingLevel,
  modelId?: string,
  thinkingBudgets?: ThinkingBudgets,
): CliEffortLevel | undefined {
  if (reasoning === undefined) {
    return undefined; // omit --effort flag entirely
  }

  if (thinkingBudgets && Object.keys(thinkingBudgets).length > 0) {
    console.warn(
      "[droid-cli] Custom thinkingBudgets are not supported with CLI subprocess. " +
        "The CLI uses --effort levels instead of token budgets. Budgets will be ignored.",
    );
  }

  const isOpus = modelId ? isOpusModel(modelId) : false;
  const map = isOpus ? OPUS_EFFORT_MAP : STANDARD_EFFORT_MAP;
  return map[reasoning];
}
