/**
 * Prompt customization foundation for runtime prompt overrides.
 *
 * This module provides:
 * - A typed catalog of stable prompt-key identifiers
 * - Metadata structures with default prompt content
 * - Resolver functions that return override text when present, otherwise fall back to defaults
 * - Deterministic fallback behavior for missing/invalid entries
 *
 * Runtime packages can use these APIs to resolve prompt text by stable keys,
 * enabling project-level customization of AI agent prompts without modifying
 * the core prompt templates in agent-prompts.ts.
 *
 * @module prompt-overrides
 */

import type { AgentCapability } from "./types.js";

// ---------------------------------------------------------------------------
// Prompt Key Catalog
// ---------------------------------------------------------------------------

/**
 * Stable identifier for a customizable prompt segment.
 *
 * Each key represents a discrete portion of an agent's prompt that can be
 * independently overridden at the project level via settings.
 */
export type PromptKey =
  | "executor-welcome"
  | "executor-guardrails"
  | "executor-spawning"
  | "executor-completion"
  | "triage-welcome"
  | "triage-context"
  | "reviewer-verdict"
  | "merger-conflicts";

/**
 * Metadata describing a prompt key including its purpose and default content.
 */
export interface PromptKeyMetadata {
  /** Stable key identifier */
  key: PromptKey;
  /** Human-readable name for UI display */
  name: string;
  /** Which agent role(s) this prompt applies to */
  roles: AgentCapability[];
  /** Short description of what this prompt segment controls */
  description: string;
  /**
   * Default prompt content.
   * Runtime packages should use resolvePrompt() to get the effective content
   * (override if present in settings, otherwise this default).
   */
  defaultContent: string;
}

/**
 * Map of prompt key to its metadata.
 */
export type PromptKeyCatalog = Record<PromptKey, PromptKeyMetadata>;

// ---------------------------------------------------------------------------
// Built-in Prompt Key Metadata
// ---------------------------------------------------------------------------

/**
 * Built-in metadata catalog for all supported prompt keys.
 * Each entry describes a customizable prompt segment with its default content.
 */
export const PROMPT_KEY_CATALOG: PromptKeyCatalog = {
  "executor-welcome": {
    key: "executor-welcome",
    name: "Executor Welcome",
    roles: ["executor"],
    description: "Introductory section for the executor agent",
    defaultContent: `You are a task execution agent for "fn", an AI-orchestrated task board.

You are working in a git worktree isolated from the main branch. Your job is to implement the task described in the PROMPT.md specification you're given.`,
  },
  "executor-guardrails": {
    key: "executor-guardrails",
    name: "Executor Guardrails",
    roles: ["executor"],
    description: "Behavioral guardrails and constraints for the executor",
    defaultContent: `## Guardrails
- Treat the File Scope in PROMPT.md as the expected starting scope, not a hard boundary when quality gates fail
- Read "Context to Read First" files before starting
- Follow the "Do NOT" section strictly
- If tests, build, or typecheck fail and the fix requires touching code outside the declared File Scope, fix those failures directly and keep the repo green`,
  },
  "executor-spawning": {
    key: "executor-spawning",
    name: "Executor Spawning",
    roles: ["executor"],
    description: "Instructions for spawning child agents",
    defaultContent: `## Spawning Child Agents

You can spawn child agents to handle parallel work or specialized sub-tasks:

**When to use \`spawn_agent\`:**
- Parallel work that can be divided into independent chunks
- Specialized tasks requiring different expertise or tools
- Delegation of sub-tasks to specialized agents

**How to spawn:**
\`\`\`javascript
spawn_agent({
  name: "researcher",
  role: "engineer",
  task: "Research best practices for authentication in React applications"
})
\`\`\``,
  },
  "executor-completion": {
    key: "executor-completion",
    name: "Executor Completion",
    roles: ["executor"],
    description: "Completion criteria and signaling for executor",
    defaultContent: `## Completion
After all steps are done, tests pass, typecheck passes, and docs are updated:
\`\`\`bash
Call \`task_done()\` to signal completion.
\`\`\``,
  },
  "triage-welcome": {
    key: "triage-welcome",
    name: "Triage Welcome",
    roles: ["triage"],
    description: "Introductory section for the triage/specification agent",
    defaultContent: `You are a task specification agent for "fn", an AI-orchestrated task board.

Your job: take a rough task description and produce a fully specified PROMPT.md that another AI agent can execute autonomously in a fresh context with zero memory of this conversation.`,
  },
  "triage-context": {
    key: "triage-context",
    name: "Triage Context",
    roles: ["triage"],
    description: "Context-gathering instructions for triage",
    defaultContent: `## What you receive
- A raw task title and optional description (the user's rough idea)
- Access to the project's files so you can understand context`,
  },
  "reviewer-verdict": {
    key: "reviewer-verdict",
    name: "Reviewer Verdict",
    roles: ["reviewer"],
    description: "Verdict criteria and format for code/review agent",
    defaultContent: `## Verdict Criteria

- **APPROVE** — Step will achieve its stated outcomes. Minor suggestions go in
  the Suggestions section but do NOT block progress. If your only findings are
  minor or suggestion-level, verdict is APPROVE.
- **REVISE** — Step will fail, produce incorrect results, or miss a stated
  requirement without fixes. Use ONLY for issues that would cause the worker to
  redo work later.
- **RETHINK** — Approach is fundamentally wrong. Explain why and suggest an
  alternative.`,
  },
  "merger-conflicts": {
    key: "merger-conflicts",
    name: "Merger Conflicts",
    roles: ["merger"],
    description: "Merge conflict resolution instructions for merger",
    defaultContent: `## Conflict resolution
If there are merge conflicts:
1. Run \`git diff --name-only --diff-filter=U\` to list conflicted files
2. Read each conflicted file — look for the <<<<<<< / ======= / >>>>>>> markers
3. Understand the intent of BOTH sides, then edit the file to produce the correct merged result
4. Remove ALL conflict markers — the result must be clean, compilable code
5. Run \`git add <file>\` for each resolved file
6. Do NOT change anything beyond what's needed to resolve the conflict`,
  },
};

/**
 * Get the metadata for a specific prompt key.
 * Returns undefined if the key is not recognized.
 */
export function getPromptKeyMetadata(key: PromptKey): PromptKeyMetadata | undefined {
  return PROMPT_KEY_CATALOG[key];
}

/**
 * Get all prompt keys for a specific agent role.
 */
export function getPromptKeysForRole(role: AgentCapability): PromptKeyMetadata[] {
  return Object.values(PROMPT_KEY_CATALOG).filter((meta) => meta.roles.includes(role));
}

// ---------------------------------------------------------------------------
// Override Entry Type
// ---------------------------------------------------------------------------

/**
 * A single prompt override entry stored in project settings.
 * The value is the custom prompt content; undefined means "use default".
 */
export type PromptOverrideEntry = string | undefined;

/**
 * Collection of prompt overrides keyed by PromptKey.
 * Stored in project settings as `promptOverrides: Record<PromptKey, string>`.
 */
export type PromptOverrideMap = Partial<Record<PromptKey, string>>;

// ---------------------------------------------------------------------------
// Resolver Functions
// ---------------------------------------------------------------------------

/**
 * Resolve the effective prompt content for a given key.
 *
 * Resolution order:
 * 1. If `overrides[key]` is a non-empty string, return the override
 * 2. Otherwise, return the default content from PROMPT_KEY_CATALOG
 *
 * @param key - The prompt key to resolve
 * @param overrides - The project-level overrides map (from settings)
 * @returns The effective prompt content (override or default)
 *
 * @example
 * ```typescript
 * const overrides: PromptOverrideMap = {
 *   "executor-welcome": "Custom welcome message..."
 * };
 * const content = resolvePrompt("executor-welcome", overrides);
 * // Returns custom welcome if set, otherwise PROMPT_KEY_CATALOG["executor-welcome"].defaultContent
 * ```
 */
export function resolvePrompt(
  key: PromptKey,
  overrides?: PromptOverrideMap,
): string {
  // Check for a valid override
  if (overrides && key in overrides) {
    const override = overrides[key];
    // Non-empty string is a valid override
    if (override !== undefined && override !== "") {
      return override;
    }
  }

  // Fall back to default
  const metadata = PROMPT_KEY_CATALOG[key];
  if (metadata) {
    return metadata.defaultContent;
  }

  // Key not found — return empty string (graceful degradation)
  return "";
}

/**
 * Resolve all prompt overrides for a given role.
 *
 * Returns a map of prompt key → effective content (override or default)
 * for all keys applicable to the specified role.
 *
 * @param role - The agent role to get prompts for
 * @param overrides - The project-level overrides map (from settings)
 * @returns Record mapping prompt keys to their effective content
 */
export function resolveRolePrompts(
  role: AgentCapability,
  overrides?: PromptOverrideMap,
): Record<PromptKey, string> {
  const result: Partial<Record<PromptKey, string>> = {};

  for (const meta of getPromptKeysForRole(role)) {
    result[meta.key] = resolvePrompt(meta.key, overrides);
  }

  return result as Record<PromptKey, string>;
}

/**
 * Check if any overrides are set for a given role.
 *
 * @param role - The agent role to check
 * @param overrides - The project-level overrides map (from settings)
 * @returns True if at least one override is set for the role
 */
export function hasRoleOverrides(
  role: AgentCapability,
  overrides?: PromptOverrideMap,
): boolean {
  if (!overrides) return false;

  const roleKeys = getPromptKeysForRole(role);
  return roleKeys.some((meta) => {
    const override = overrides[meta.key];
    return override !== undefined && override !== "";
  });
}

/**
 * Get all overridden keys (keys with non-empty override values).
 *
 * @param overrides - The project-level overrides map
 * @returns Array of keys that have overrides set
 */
export function getOverriddenKeys(overrides?: PromptOverrideMap): PromptKey[] {
  if (!overrides) return [];

  return (Object.keys(overrides) as PromptKey[]).filter(
    (key) => overrides[key] !== undefined && overrides[key] !== "",
  );
}

/**
 * Clear specific override keys by setting them to undefined.
 * Used by TaskStore.updateSettings() to implement null-as-delete semantics.
 *
 * @param overrides - Current overrides map
 * @param keysToClear - Keys to clear (set to undefined)
 * @returns New overrides map with specified keys cleared
 */
export function clearOverrides(
  overrides: PromptOverrideMap | undefined,
  keysToClear: PromptKey[],
): PromptOverrideMap | undefined {
  if (!overrides && keysToClear.length === 0) {
    return undefined;
  }

  const result: PromptOverrideMap = { ...overrides };

  for (const key of keysToClear) {
    delete result[key];
  }

  // Return undefined if map becomes empty (runtime uses defaults)
  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}

/**
 * Validate that a value is a valid PromptKey.
 *
 * @param value - Value to check
 * @returns True if the value is a valid PromptKey
 */
export function isValidPromptKey(value: unknown): value is PromptKey {
  if (typeof value !== "string") return false;
  return value in PROMPT_KEY_CATALOG;
}

/**
 * Validate that an object is a valid PromptOverrideMap.
 *
 * @param value - Value to check
 * @returns True if the value is a valid PromptOverrideMap
 */
export function isValidPromptOverrideMap(value: unknown): value is PromptOverrideMap {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const obj = value as Record<string, unknown>;

  for (const [key, val] of Object.entries(obj)) {
    if (!isValidPromptKey(key)) {
      return false;
    }
    // Values must be strings or undefined
    if (val !== undefined && typeof val !== "string") {
      return false;
    }
  }

  return true;
}

/**
 * Type guard to ensure a value is a valid PromptOverrideMap.
 * Throws if the value is not a valid PromptOverrideMap.
 *
 * @param value - Value to validate
 * @throws Error if the value is not a valid PromptOverrideMap
 */
export function assertValidPromptOverrideMap(value: unknown): asserts value is PromptOverrideMap {
  if (!isValidPromptOverrideMap(value)) {
    throw new Error(
      `Invalid prompt override map: expected Record<PromptKey, string | undefined>, got ${typeof value}`
    );
  }
}
