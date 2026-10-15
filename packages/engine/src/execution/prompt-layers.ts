/**
 * Prompt composition seam — the single authority on what may enter a serialized
 * system prompt.
 *
 * Provider prefix caching matches request prefixes, so it pays only for content that is
 * byte-identical at the same byte position in every request. Volatile content that shares a
 * prefix but differs later still forces a full cache miss from its divergence byte onward, and
 * no amount of reordering inside the system prompt changes that: the request diverges at the
 * volatile block's first byte wherever it sits. Byte-stability per role therefore requires the
 * serialized system prompt to contain NO runtime-mutable content at all.
 *
 * The contract this module enforces (RUFU-267):
 * - `stable` — the role head: base role prompt plus per-role runtime self-awareness.
 * - `dynamic` — CONFIG-TIME role additions only (agent instructions/soul, memory *instruction*
 *   text, plugin contributions, settings-derived directives). `stable + dynamic` is what
 *   `collapsePromptLayers()` produces and what a lane sends as its system prompt, so the pair is
 *   byte-identical across same-role requests until an operator edits configuration.
 * - The request tail — everything derived from mutable state (database rows, memory files, board
 *   contents, the clock, a per-card or per-session selection) is built by
 *   `buildRequestVolatileContext()` and appended to that turn's user message by
 *   `appendRequestVolatileContext()`.
 *
 * Why the volatile half could not simply stay in `dynamic`: every lane flattens its layers with
 * `collapsePromptLayers()` into one `systemPrompt` string, and even the structured path keeps both
 * layers inside the system message — `pi.ts` maps `dynamic` to pi's `appendSystemPromptOverride`,
 * which pi joins into the system prompt as its addendum. `dynamic` has never had a byte position
 * outside the serialized system prompt, so "dynamic" was never a cache boundary. The volatile half
 * now has a real one: the request tail.
 *
 * FNXC:PromptByteStability 2026-09-24-02:10:
 * RUFU-267 removed the volatile fields from `PromptLayerInput` (`memorySection`, `goalContext`,
 * `performanceFeedback`) rather than merely documenting them as forbidden: a lane must not be able
 * to express the old composition at all. `memoryInstructions` replaces `memorySection` and is the
 * static "how to use memory" guidance only — memory BODIES and their heading index are volatile and
 * belong in `buildRequestVolatileContext({ memorySection })`. The renamed config field and the
 * removed volatile names are what the `check:prompt-volatility` guard keys off, and
 * `packages/engine/src/__tests__/prompt-layers.test.ts` re-pins the field-name list so a rename
 * cannot silently disarm that guard.
 *
 * @see packages/engine/src/__tests__/prompt-layers.test.ts
 * @see docs/prompt-composition.md
 */

/** Ordered prompt layers for cross-request prefix caching. */
export interface SystemPromptLayers {
  /** Role head — changes only on runtime code changes. Cached first. */
  stable: string;
  /** Config-time role additions only — byte-stable per (role, role configuration). */
  dynamic: string;
}

/**
 * Inputs to the serialized system prompt. Every field here is config-time by the rule below;
 * runtime-mutable state has no field, because it may not enter the system prompt.
 *
 * Decision rule (config-time in, state out): a block may stay in the serialized system prompt
 * only if its bytes change exclusively through an operator configuration edit. Anything derived
 * from mutable state — database rows, memory files, board contents, the clock, or a per-card /
 * per-session selection — rides the request tail instead. Per-card content counts as volatile
 * even when nobody edits anything: two consecutive same-role requests serve different cards, so
 * its bytes differ between them and the cache would miss.
 */
export interface PromptLayerInput {
  /** Role-specific base prompt (executor/reviewer/triage/heartbeat) — a constant or settings render. */
  basePrompt: string;
  /** Config-time agent instruction text (instructionsText / instructionsPath / soul), or its parts. */
  agentInstructions?: string | string[];
  /**
   * Static guidance about HOW to use memory (mode-rendered instruction text). Memory content
   * itself is volatile and goes through `buildRequestVolatileContext({ memorySection })`.
   */
  memoryInstructions?: string;
  /** Plugin prompt contributions — plugin install/enable is a configuration edit. */
  pluginContributions?: string;
  /** Settings-derived operator language directive. */
  operatorLanguageDirective?: string;
}

/**
 * Runtime-mutable blocks that ride the request tail (the end of the user message of the turn that
 * needs them) instead of the serialized system prompt. Field names are also the static guard's
 * vocabulary — see `SYSTEM_PROMPT_VOLATILE_FIELD_NAMES`.
 */
export interface RequestVolatileInput {
  /** Agent memory bodies (or their bounded heading index, whose file names are dates). */
  memorySection?: string;
  /** Active goals / mission context resolved from the goal store. */
  goalContext?: string;
  /** Per-card or per-session identity block (assigned planner agent, workflow column persona). */
  identitySection?: string;
  /** Rating-summary derived performance-feedback section. */
  performanceFeedback?: string;
  /** Self-improvement prompt — carries the last-self-improvement clock reading. */
  selfImprovePrompt?: string;
  /** Per-card policy blocks: duplicate policy, planning-dependency instruction, withheld-tool guidance. */
  policySections?: string;
  /** Task-specific review policy resolved from the selected workflow's review node. */
  taskReviewPolicy?: string;
  /** Per-request board context: chat mention context, task-planner task snapshot. */
  requestBoardContext?: string;
  /** Per-turn memory recall cue derived from the current user message. */
  memoryRecall?: string;
}

/**
 * Heading that introduces relocated blocks in the request tail. It tells the model these are
 * authoritative runtime context for this request rather than user chatter, which is the property
 * volatile blocks lost when they left the system prompt.
 */
export const SESSION_CONTEXT_HEADING = "## Session Context (runtime state, refreshed per request)";

/**
 * Volatile field names that must never reappear as `PromptLayerInput` fields nor be passed into a
 * system-prompt slot. Exported for the static guard and its drift test; the guard matches
 * word-boundary occurrences in source text, so plain string literals are intentional — importing
 * them would look like a system-prompt argument to a source scan.
 */
export const SYSTEM_PROMPT_VOLATILE_FIELD_NAMES = [
  "memorySection",
  "goalContext",
  "performanceFeedback",
  "identitySection",
  "selfImprovePrompt",
  "taskReviewPolicy",
  "triageIdentitySection",
  "duplicatePolicyInstruction",
  "planningDependencyInstruction",
] as const;

/**
 * Files whose source is allowed to name volatile fields: this module (which owns the tail API that
 * legitimately consumes them) and tests. Every other producer is a violation — see
 * `scripts/check-prompt-volatility.mjs`.
 */
export const PROMPT_VOLATILITY_GUARD_ID = "check:prompt-volatility";

/** Join non-empty prompt sections with a blank line, skipping blanks. */
function joinSections(sections: Array<string | string[] | undefined>): string {
  const parts: string[] = [];
  for (const section of sections) {
    if (section === undefined) continue;
    for (const piece of Array.isArray(section) ? section : [section]) {
      if (piece?.trim()) parts.push(piece);
    }
  }
  return parts.join("\n\n");
}

/**
 * Build structured prompt layers from a config-time-only input set.
 *
 * `stable` holds the role head. `dynamic` holds config-time role additions in a fixed order so the
 * collapsed result stays byte-identical across same-role requests: memory instructions, custom
 * instructions, plugin contributions, operator language directive.
 *
 * The retired order (RUFU-267, Step 3) interleaved runtime state between the role head and the
 * config-time sections:
 *   1. basePrompt
 *   2. agentInstructions            ← held memory bodies + rating summary
 *   3. memorySection                ← memory bodies / date-bearing index            [VOLATILE]
 *   4. goalContext                  ← live goal rows                                [VOLATILE]
 *   5. pluginContributions
 *   6. performanceFeedback          ← rating summary                                [VOLATILE]
 *   7. operatorLanguageDirective
 * The order of the surviving config-time sections is preserved (they still contribute the same
 * bytes in the same relative sequence); positions 3, 4 and 6 no longer exist in the system prompt
 * at all, and the per-card identity/policy sections that lanes prepended to `basePrompt` moved to
 * the tail too.
 */
export function buildPromptLayers(input: PromptLayerInput): SystemPromptLayers {
  const dynamicParts: string[] = [];

  if (input.memoryInstructions?.trim()) {
    dynamicParts.push(input.memoryInstructions);
  }

  if (input.agentInstructions) {
    const instructions = Array.isArray(input.agentInstructions)
      ? input.agentInstructions.filter((part) => part?.trim())
      : [input.agentInstructions];
    if (instructions.length > 0) {
      // The heading is the legacy `buildSystemPromptWithInstructions` shape, kept byte-for-byte so a
      // lane moving from the collapsed helper to layers changes no prompt text (RUFU-267 moves byte
      // positions, never wording).
      dynamicParts.push(`## Custom Instructions\n\n${instructions.join("\n\n")}`);
    }
  }

  if (input.pluginContributions?.trim()) {
    dynamicParts.push(input.pluginContributions);
  }

  if (input.operatorLanguageDirective?.trim()) {
    dynamicParts.push(input.operatorLanguageDirective);
  }

  return {
    stable: input.basePrompt,
    dynamic: dynamicParts.join("\n\n"),
  };
}

/**
 * Collapse layers into a single string for runtimes without native layer support.
 *
 * Byte-stable per (role, role configuration) by construction: `PromptLayerInput` accepts no
 * runtime-mutable field, so nothing that mutates between two same-role requests can reach here.
 */
export function collapsePromptLayers(layers: SystemPromptLayers): string {
  if (!layers.dynamic) return layers.stable;
  return `${layers.stable}\n\n${layers.dynamic}`;
}

/**
 * Render relocated runtime-mutable blocks into one request-tail block.
 *
 * Section order is fixed and mirrors the relative order the blocks held in the retired system-prompt
 * composition (memory → goals → identity/policy → feedback → task-specific policy → per-request
 * board context → per-turn recall), so a model that previously read these blocks in the system
 * prompt reads them in the same sequence, now at the end of the request. Each block keeps its own
 * `##` heading; only the byte position changed, never the sentences.
 *
 * Returns "" when nothing is volatile for this request, so a lane can append unconditionally.
 */
export function buildRequestVolatileContext(input: RequestVolatileInput): string {
  const sections = joinSections([
    input.memorySection,
    input.goalContext,
    input.identitySection,
    input.policySections,
    input.performanceFeedback,
    input.taskReviewPolicy,
    input.requestBoardContext,
    input.memoryRecall,
    input.selfImprovePrompt,
  ]);
  if (!sections) return "";
  return `${SESSION_CONTEXT_HEADING}\n\n${sections}`;
}

/**
 * Append the request-tail context block to the prompt that carries this turn's user message.
 *
 * This is the seam every lane uses for runtime-mutable prompt content. It is an append to the
 * request, never to the system prompt: the system prompt stays byte-identical so the provider's
 * prefix cache covers it, while the tail — which the cache never charged for anyway — carries the
 * state.
 */
export function appendRequestVolatileContext(requestPrompt: string, volatileContext: string): string {
  if (!volatileContext.trim()) return requestPrompt;
  if (!requestPrompt.trim()) return volatileContext;
  return `${requestPrompt}\n\n${volatileContext}`;
}

/**
 * Convenience for a single call site: render the volatile blocks and append them to a request prompt
 * in one step, so a lane cannot accidentally drop one half of the pair.
 */
export function withRequestVolatileContext(requestPrompt: string, input: RequestVolatileInput): string {
  return appendRequestVolatileContext(requestPrompt, buildRequestVolatileContext(input));
}
