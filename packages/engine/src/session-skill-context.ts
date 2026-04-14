/**
 * Shared skill selection context helper for session creation.
 *
 * Centralizes requested-skill extraction from agent metadata and callback wiring
 * for consistent skill selection across all session types (triage, executor,
 * step-session, reviewer, merger, heartbeat).
 *
 * ## Precedence Rules
 *
 * 1. **Assigned Agent Skills**: If `task.assignedAgentId` resolves to an agent
 *    with valid normalized skills in `agent.metadata.skills`, those skills are used.
 *
 * 2. **Role Fallback Skills**: If assigned agent is missing or has no valid skills,
 *    use subsystem role fallback mapping:
 *    - `triage` → `triage`
 *    - `executor` / `step-session` → `executor`
 *    - `reviewer` → `reviewer`
 *    - `merger` → `merger`
 *    - `heartbeat` → no role fallback (use waking agent only)
 *
 * 3. **No Skills**: If neither source provides valid skills, pass no requested skills.
 *
 * ## Normalization
 *
 * `metadata.skills` entries are normalized deterministically:
 * - String entries are trimmed and filtered for non-empty
 * - Object entries with `name` property are extracted and trimmed
 * - Invalid/empty entries are dropped
 * - Results are deduplicated preserving stable insertion order
 */

import type { TaskStore } from "@fusion/core";
import type { Agent } from "@fusion/core";
import type { SkillSelectionContext } from "./skill-resolver.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Session purpose for skill selection context.
 * Maps to role fallback skills when no assigned agent is available.
 */
export type SessionPurpose = "triage" | "executor" | "reviewer" | "merger" | "heartbeat";

/**
 * Input parameters for building session skill context.
 */
export interface SessionSkillContextInput {
  /** Task store for looking up assigned agent */
  taskStore: TaskStore;
  /** Task with optional assignedAgentId */
  task: { assignedAgentId?: string | null };
  /** Purpose of the session (determines role fallback) */
  sessionPurpose: SessionPurpose;
  /** Absolute path to project root */
  projectRootDir: string;
}

/**
 * Result of building session skill context.
 * Contains the SkillSelectionContext for createKbAgent and any diagnostics.
 */
export interface SessionSkillContextResult {
  /** Context to pass to createKbAgent's skillSelection option */
  skillSelectionContext: SkillSelectionContext | undefined;
  /** Normalized skill names that were resolved (for logging/debugging) */
  resolvedSkillNames: string[];
  /** Source of the skills: 'assigned-agent', 'role-fallback', or 'none' */
  skillSource: "assigned-agent" | "role-fallback" | "none";
}

// ── Skill Normalization ─────────────────────────────────────────────────────

/**
 * Normalize agent metadata skills deterministically.
 * - Accepts string entries and object entries with `name` property
 * - Trims whitespace, drops invalid/empty entries, deduplicates
 * - Preserves stable insertion order
 */
export function normalizeAgentSkills(
  metadataSkills: unknown,
): string[] {
  if (!Array.isArray(metadataSkills)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of metadataSkills) {
    let name: string | undefined;

    if (typeof entry === "string") {
      name = entry.trim();
    } else if (entry && typeof entry === "object") {
      const namedEntry = (entry as Record<string, unknown>).name;
      if (typeof namedEntry === "string") {
        name = namedEntry.trim();
      }
    }

    // Skip invalid/empty entries and deduplicate
    if (name && name.length > 0 && !seen.has(name)) {
      seen.add(name);
      result.push(name);
    }
  }

  return result;
}

// ── Role Fallback Mapping ───────────────────────────────────────────────────

/**
 * Map session purpose to role fallback skill names.
 * Heartbeat has no role fallback (uses waking agent only).
 */
const ROLE_FALLBACK_SKILLS: Record<Exclude<SessionPurpose, "heartbeat">, string[]> = {
  triage: ["triage"],
  executor: ["executor"],
  reviewer: ["reviewer"],
  merger: ["merger"],
};

/**
 * Get role fallback skill names for a session purpose.
 * Returns undefined for heartbeat (no role fallback).
 */
function getRoleFallbackSkills(
  sessionPurpose: SessionPurpose,
): string[] | undefined {
  if (sessionPurpose === "heartbeat") {
    // No role fallback for heartbeat - uses waking agent only
    return undefined;
  }
  return ROLE_FALLBACK_SKILLS[sessionPurpose];
}

// ── Diagnostic Message Templates ─────────────────────────────────────────────

/**
 * Shared diagnostic message templates for consistent logging.
 */
export const SKILL_DIAGNOSTIC_MESSAGES = {
  missing: (skillName: string): string =>
    `skill selection: requested skill "${skillName}" not found in discovered skills`,

  filtered: (skillName: string): string =>
    `skill selection: requested skill "${skillName}" filtered out by execution-enabled settings`,

  assignedAgentSkills: (count: number, agentId: string): string =>
    `Using skills from assigned agent ${agentId} (${count} skills)`,

  roleFallbackSkills: (purpose: SessionPurpose, skills: string[]): string =>
    `Using role fallback skills for ${purpose}: [${skills.join(", ")}]`,

  noSkillsAvailable: (purpose: SessionPurpose): string =>
    `No skills available for ${purpose} session (no assigned agent, no role fallback)`,
} as const;

// ── Main Builder ────────────────────────────────────────────────────────────

/**
 * Build session skill context for createKbAgent.
 *
 * Applies precedence rules:
 * 1. Use assigned agent skills if available
 * 2. Fall back to role-based skills if no assigned agent or no valid skills
 * 3. Skip skill selection entirely if neither source provides valid skills
 *
 * @param input - Session skill context input parameters
 * @returns Skill selection context result with diagnostics
 */
export async function buildSessionSkillContext(
  input: SessionSkillContextInput,
): Promise<SessionSkillContextResult> {
  const { taskStore, task, sessionPurpose, projectRootDir } = input;
  const { assignedAgentId } = task;

  // Rule 1: Check assigned agent
  if (assignedAgentId) {
    try {
      const agent = await taskStore.getAgent(assignedAgentId);
      if (agent) {
        const agentSkills = normalizeAgentSkills(
          (agent.metadata as Record<string, unknown> | undefined)?.skills,
        );

        if (agentSkills.length > 0) {
          // Found valid skills from assigned agent
          const skillSelectionContext: SkillSelectionContext = {
            projectRootDir,
            requestedSkillNames: agentSkills,
            sessionPurpose,
          };

          return {
            skillSelectionContext,
            resolvedSkillNames: agentSkills,
            skillSource: "assigned-agent",
          };
        }
      }
    } catch {
      // Agent lookup failed - fall through to role fallback
    }
  }

  // Rule 2: Use role fallback skills
  const roleFallbackSkills = getRoleFallbackSkills(sessionPurpose);

  if (roleFallbackSkills && roleFallbackSkills.length > 0) {
    const skillSelectionContext: SkillSelectionContext = {
      projectRootDir,
      requestedSkillNames: roleFallbackSkills,
      sessionPurpose,
    };

    return {
      skillSelectionContext,
      resolvedSkillNames: roleFallbackSkills,
      skillSource: "role-fallback",
    };
  }

  // Rule 3: No skills available
  return {
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none",
  };
}

// ── Sync Builder (for hot paths) ────────────────────────────────────────────

/**
 * Build session skill context synchronously using cached agent data.
 *
 * Use this when you have the agent already loaded (e.g., from cache)
 * to avoid async agent lookup overhead.
 */
export function buildSessionSkillContextSync(
  agent: Agent | null | undefined,
  sessionPurpose: SessionPurpose,
  projectRootDir: string,
): SessionSkillContextResult {
  // Rule 1: Check assigned agent skills
  if (agent) {
    const agentSkills = normalizeAgentSkills(
      (agent.metadata as Record<string, unknown> | undefined)?.skills,
    );

    if (agentSkills.length > 0) {
      const skillSelectionContext: SkillSelectionContext = {
        projectRootDir,
        requestedSkillNames: agentSkills,
        sessionPurpose,
      };

      return {
        skillSelectionContext,
        resolvedSkillNames: agentSkills,
        skillSource: "assigned-agent",
      };
    }
  }

  // Rule 2: Use role fallback skills
  const roleFallbackSkills = getRoleFallbackSkills(sessionPurpose);

  if (roleFallbackSkills && roleFallbackSkills.length > 0) {
    const skillSelectionContext: SkillSelectionContext = {
      projectRootDir,
      requestedSkillNames: roleFallbackSkills,
      sessionPurpose,
    };

    return {
      skillSelectionContext,
      resolvedSkillNames: roleFallbackSkills,
      skillSource: "role-fallback",
    };
  }

  // Rule 3: No skills available
  return {
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none",
  };
}
