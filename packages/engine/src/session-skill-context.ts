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
 *    use the built-in Fusion skill fallback mapping:
 *    - `triage` → `fusion`
 *    - `executor` / `step-session` → `fusion`
 *    - `reviewer` → `fusion`
 *    - `merger` → `fusion`
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

import { dirname } from "node:path";
import type { Agent, AgentStore } from "@fusion/core";
import { resolvePluginSkillBodyPath, resolvePluginSkillEnabled } from "@fusion/core";
import { piLog } from "./logger.js";
import type { PluginRunner } from "./plugin-runner.js";
import { readProjectSettings, resolveProjectRoot, type SkillSelectionContext } from "./skill-resolver.js";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Session purpose for skill selection context.
 * Maps to built-in fallback skills when no assigned agent is available.
 */
export type SessionPurpose = "triage" | "executor" | "reviewer" | "merger" | "heartbeat";

/**
 * Input parameters for building session skill context.
 */
export interface SessionSkillContextInput {
  /** Agent store for looking up assigned agent */
  agentStore: AgentStore;
  /** Task with optional assignedAgentId */
  task: { assignedAgentId?: string | null };
  /** Purpose of the session (determines role fallback) */
  sessionPurpose: SessionPurpose;
  /** Absolute path to project root */
  projectRootDir: string;
  /** Optional plugin runner for plugin-contributed skills */
  pluginRunner?: PluginRunner;
}

/**
 * Result of building session skill context.
 * Contains the SkillSelectionContext for createFnAgent and any diagnostics.
 */
export interface SessionSkillContextResult {
  /** Context to pass to createFnAgent's skillSelection option */
  skillSelectionContext: SkillSelectionContext | undefined;
  /** Normalized skill names that were resolved (for logging/debugging) */
  resolvedSkillNames: string[];
  /** Source of the skills: 'assigned-agent', 'role-fallback', or 'none' */
  skillSource: "assigned-agent" | "role-fallback" | "none";
  /** Extra skill body directories to pass to createFnAgent's additionalSkillPaths */
  additionalSkillPaths: string[];
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

    // Skip invalid/empty entries and deduplicate.
    // If the entry is a full skill ID ("source::path"), extract just the
    // skill name (last two path segments) so it matches the discovered
    // skill.name produced by extractSkillName().
    if (name && name.length > 0) {
      if (name.includes("::")) {
        const idPath = name.split("::").pop()!;
        const parts = idPath.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length >= 2) {
          name = parts.slice(-2).join("/");
        }
      }
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }

  return result;
}

/**
 * FNXC:PluginSkills 2026-07-12-00:00:
 * Session assembly must honor the same per-project plugin-skill override as the Skills view. Resolve worktree project roots before reading settings, then delegate effective enablement to @fusion/core so static plugin defaults cannot drift from project toggles again.
 *
 * FNXC:PluginSkills 2026-07-12-00:00:
 * GitHub #2017 showed that plugin skill names alone never delivered bodies because the pi loader does not scan plugin packages. Resolve each enabled plugin skill body through @fusion/core's traversal-guarded primitive and thread its body directory plus parent discovery root as additionalSkillPaths, mirroring the compound-engineering FUSION_CE_SKILLS_DIR mechanism while preserving the explicit body-dir contract.
 */
export function collectPluginSkillNames(
  pluginRunner: PluginRunner | undefined,
  projectRootDir?: string,
): { names: string[]; pluginIds: string[]; additionalSkillPaths: string[] } {
  if (!pluginRunner) {
    return { names: [], pluginIds: [], additionalSkillPaths: [] };
  }

  let settings = {};
  if (projectRootDir) {
    try {
      settings = readProjectSettings(resolveProjectRoot(projectRootDir));
    } catch {
      settings = {};
    }
  }

  const pluginSkills = pluginRunner.getPluginSkills();
  const seenNames = new Set<string>();
  const pluginIds = new Set<string>();
  const additionalSkillPathSet = new Set<string>();
  const names: string[] = [];

  for (const contribution of pluginSkills) {
    const { pluginId, skill } = contribution;
    const name = skill.name.trim();
    let bodyPath: ReturnType<typeof resolvePluginSkillBodyPath> | undefined;

    if (contribution.pluginRoot) {
      try {
        bodyPath = resolvePluginSkillBodyPath(skill, contribution.pluginRoot);
      } catch (error) {
        piLog.warn(
          `[skills] Plugin ${pluginId} skill ${name} body path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (!resolvePluginSkillEnabled(settings, pluginId, name, skill.enabled, bodyPath?.relativePath)) {
      continue;
    }

    if (name.length === 0 || seenNames.has(name)) {
      continue;
    }

    seenNames.add(name);
    pluginIds.add(pluginId);
    names.push(name);

    if (bodyPath) {
      const bodyDir = dirname(bodyPath.absolutePath);
      additionalSkillPathSet.add(bodyDir);
      additionalSkillPathSet.add(dirname(bodyDir));
    }

    piLog.log(`[skills] Plugin ${pluginId} contributes skill: ${name}`);
  }

  return {
    names,
    pluginIds: Array.from(pluginIds),
    additionalSkillPaths: Array.from(additionalSkillPathSet),
  };
}

// ── Role Fallback Mapping ───────────────────────────────────────────────────

/**
 * Map session purpose to role fallback skill names.
 * Heartbeat has no role fallback (uses waking agent only).
 */
const ROLE_FALLBACK_SKILLS: Record<Exclude<SessionPurpose, "heartbeat">, string[]> = {
  triage: ["fusion"],
  executor: ["fusion"],
  reviewer: ["fusion"],
  merger: ["fusion"],
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
 * Build session skill context for createFnAgent.
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
  const { agentStore, task, sessionPurpose, projectRootDir } = input;
  const { assignedAgentId } = task;

  // Rule 1: Check assigned agent
  if (assignedAgentId) {
    try {
      const agent = await agentStore.getAgent(assignedAgentId);
      if (agent) {
        const agentSkills = normalizeAgentSkills(
          (agent.metadata as Record<string, unknown> | undefined)?.skills,
        );

        if (agentSkills.length > 0) {
          return mergePluginSkills(
            {
              skillSelectionContext: {
                projectRootDir,
                requestedSkillNames: agentSkills,
                sessionPurpose,
              },
              resolvedSkillNames: agentSkills,
              skillSource: "assigned-agent",
              additionalSkillPaths: [],
            },
            sessionPurpose,
            projectRootDir,
            input.pluginRunner,
          );
        }
      }
    } catch {
      // Agent lookup failed - fall through to role fallback
    }
  }

  return mergePluginSkills(
    resolveRoleFallback(sessionPurpose, projectRootDir),
    sessionPurpose,
    projectRootDir,
    input.pluginRunner,
  );
}

function resolveRoleFallback(
  sessionPurpose: SessionPurpose,
  projectRootDir: string,
): SessionSkillContextResult {
  const roleFallbackSkills = getRoleFallbackSkills(sessionPurpose);

  if (roleFallbackSkills && roleFallbackSkills.length > 0) {
    return {
      skillSelectionContext: {
        projectRootDir,
        requestedSkillNames: roleFallbackSkills,
        sessionPurpose,
      },
      resolvedSkillNames: roleFallbackSkills,
      skillSource: "role-fallback",
      additionalSkillPaths: [],
    };
  }

  return {
    skillSelectionContext: undefined,
    resolvedSkillNames: [],
    skillSource: "none",
    additionalSkillPaths: [],
  };
}

function mergeAdditionalSkillPaths(...pathGroups: string[][]): string[] {
  return Array.from(new Set(pathGroups.flat()));
}

function mergePluginSkills(
  baseResult: SessionSkillContextResult,
  sessionPurpose: SessionPurpose,
  projectRootDir: string,
  pluginRunner: PluginRunner | undefined,
): SessionSkillContextResult {
  const { names: pluginSkillNames, additionalSkillPaths } = collectPluginSkillNames(pluginRunner, projectRootDir);
  if (pluginSkillNames.length === 0) {
    return { ...baseResult, additionalSkillPaths: mergeAdditionalSkillPaths(baseResult.additionalSkillPaths, additionalSkillPaths) };
  }

  const mergedNames = [...baseResult.resolvedSkillNames];
  const existingNames = new Set(mergedNames.map((name) => name.toLowerCase()));
  const appendedPluginNames: string[] = [];

  for (const pluginSkillName of pluginSkillNames) {
    const key = pluginSkillName.toLowerCase();
    if (existingNames.has(key)) {
      continue;
    }

    existingNames.add(key);
    mergedNames.push(pluginSkillName);
    appendedPluginNames.push(pluginSkillName);
  }

  if (appendedPluginNames.length > 0) {
    piLog.log(
      `[skills] Merged ${appendedPluginNames.length} plugin skill(s) into ${sessionPurpose} session: [${appendedPluginNames.join(", ")}]`,
    );
  }

  if (mergedNames.length === 0) {
    return { ...baseResult, additionalSkillPaths: mergeAdditionalSkillPaths(baseResult.additionalSkillPaths, additionalSkillPaths) };
  }

  return {
    skillSelectionContext: {
      projectRootDir,
      requestedSkillNames: mergedNames,
      sessionPurpose,
    },
    resolvedSkillNames: mergedNames,
    skillSource: baseResult.skillSource === "none" ? "role-fallback" : baseResult.skillSource,
    additionalSkillPaths: mergeAdditionalSkillPaths(baseResult.additionalSkillPaths, additionalSkillPaths),
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
  pluginRunner?: PluginRunner,
): SessionSkillContextResult {
  // Rule 1: Check assigned agent skills
  if (agent) {
    const agentSkills = normalizeAgentSkills(
      (agent.metadata as Record<string, unknown> | undefined)?.skills,
    );

    if (agentSkills.length > 0) {
      return mergePluginSkills(
        {
          skillSelectionContext: {
            projectRootDir,
            requestedSkillNames: agentSkills,
            sessionPurpose,
          },
          resolvedSkillNames: agentSkills,
          skillSource: "assigned-agent",
          additionalSkillPaths: [],
        },
        sessionPurpose,
        projectRootDir,
        pluginRunner,
      );
    }
  }

  return mergePluginSkills(
    resolveRoleFallback(sessionPurpose, projectRootDir),
    sessionPurpose,
    projectRootDir,
    pluginRunner,
  );
}
