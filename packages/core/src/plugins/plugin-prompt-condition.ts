import type { PluginSettingSchema } from "./plugin-types.js";

export interface PromptConditionEvaluationResult {
  included: boolean;
  reason?: string;
}

const PROMPT_CONDITION_PATTERN = /^\s*settings\s*\[\s*(["'])([^"'\\]+)\1\s*\]\s*(===|!==)\s*(["'])([^"'\\]*)\4\s*$/;

/**
 * FNXC:PluginPrompt 2026-07-10-00:00:
 * Plugin prompt conditions are plugin-authored strings that gate prompt injection, so the host must treat them as data.
 * Evaluate only the documented single-comparison grammar with a deterministic regex; never use eval, Function, vm, or executable interpolation.
 */
export function evaluatePromptConditionDetailed(
  condition: string | undefined,
  settings: Record<string, unknown>,
): PromptConditionEvaluationResult {
  if (condition === undefined || condition.trim() === "") {
    return { included: true };
  }

  const match = PROMPT_CONDITION_PATTERN.exec(condition);
  if (!match) {
    return { included: false, reason: "unsupported prompt contribution condition grammar" };
  }

  const [, , key, operator, , expected] = match;
  const actual = settings[key];
  const equals = typeof actual === "string" && actual === expected;
  return { included: operator === "===" ? equals : !equals };
}

export function evaluatePromptCondition(condition: string | undefined, settings: Record<string, unknown>): boolean {
  return evaluatePromptConditionDetailed(condition, settings).included;
}

export function resolveEffectivePluginSettings(
  stored: Record<string, unknown> | undefined,
  schema?: Record<string, PluginSettingSchema>,
): Record<string, unknown> {
  const effective: Record<string, unknown> = {};

  for (const [key, setting] of Object.entries(schema ?? {})) {
    if (Object.prototype.hasOwnProperty.call(setting, "defaultValue")) {
      effective[key] = setting.defaultValue;
    }
  }

  return { ...effective, ...(stored ?? {}) };
}
