/**
 * Structured system prompt layers for cross-session caching.
 *
 * The `stable` layer contains content that is identical across sessions of
 * the same role (base role prompt). The `dynamic` layer holds per-session
 * content (agent instructions, memory, performance feedback, plugins).
 *
 * When the stable layer is byte-identical across consecutive API calls,
 * Anthropic's prompt cache gives a 90% read discount. OpenAI caches
 * matching prefixes automatically at 50% discount.
 */
export interface SystemPromptLayers {
  /** Role-specific base prompt — identical across all sessions of this role. */
  stable: string;
  /** Per-session content: agent instructions, memory, feedback, plugins. */
  dynamic: string;
}

export interface PromptLayerInput {
  /** The base role system prompt (for reviewer, the workflow IR review seam prompt). */
  basePrompt: string;
  /** Resolved agent instructions (instructionsText + instructionsPath + soul). */
  agentInstructions?: string;
  /** Formatted memory section (agent memory + workspace memory). */
  memorySection?: string;
  /** Formatted active-goals context section. */
  goalContext?: string;
  /** Formatted plugin prompt contributions. */
  pluginContributions?: string;
  /** Formatted performance feedback section. */
  performanceFeedback?: string;
  /**
   * Prebuilt operator-language directive (core buildOperatorLanguageDirective) for the lane's
   * resolved settings.
   *
   * FNXC:OperatorLanguage 2026-09-16-13:05:
   * RUFU PR review: every lane whose operator-facing prose the setting promises to steer
   * (executor task logs, reviewer verdicts, triage planning output) must carry the directive, so
   * the seam that already composes every lane's prompt is the single injection point. Empty or
   * `"auto"` settings produce no directive and leave prompts byte-identical.
   */
  operatorLanguageDirective?: string;
}

/**
 * Build structured prompt layers from the components that currently get
 * concatenated into a single system prompt string.
 *
 * The stable layer is ONLY the base role prompt. Everything else goes into
 * the dynamic layer so that the stable prefix is byte-identical across
 * sessions of the same role, enabling cross-session prompt caching.
 */
export function buildPromptLayers(input: PromptLayerInput): SystemPromptLayers {
  const { basePrompt, agentInstructions, memorySection, goalContext, pluginContributions, performanceFeedback, operatorLanguageDirective } = input;

  const dynamicParts: string[] = [];

  // Memory section comes before instructions to preserve the relative
  // ordering from the legacy buildSystemPromptWithInstructions approach,
  // where memory was concatenated onto basePrompt before instructions
  // were appended.
  const trimmedMemory = memorySection?.trim() ?? "";
  if (trimmedMemory) {
    dynamicParts.push(trimmedMemory);
  }

  const trimmedGoalContext = goalContext?.trim() ?? "";
  if (trimmedGoalContext) {
    dynamicParts.push(trimmedGoalContext);
  }

  const trimmedInstructions = agentInstructions?.trim() ?? "";
  if (trimmedInstructions) {
    dynamicParts.push(`## Custom Instructions\n\n${trimmedInstructions}`);
  }

  const trimmedPlugins = pluginContributions?.trim() ?? "";
  if (trimmedPlugins) {
    dynamicParts.push(trimmedPlugins);
  }

  const trimmedFeedback = performanceFeedback?.trim() ?? "";
  if (trimmedFeedback) {
    dynamicParts.push(trimmedFeedback);
  }

  const trimmedOperatorLanguage = operatorLanguageDirective?.trim() ?? "";
  if (trimmedOperatorLanguage) {
    dynamicParts.push(trimmedOperatorLanguage);
  }

  return {
    stable: basePrompt,
    dynamic: dynamicParts.join("\n\n"),
  };
}

/**
 * Collapse layers back into a single string for backward compatibility.
 * Runtimes that don't support structured caching use this to get the same
 * concatenated prompt as before.
 */
export function collapsePromptLayers(layers: SystemPromptLayers): string {
  if (!layers.dynamic) {
    return layers.stable;
  }
  return `${layers.stable}\n\n${layers.dynamic}`;
}
