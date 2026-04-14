/**
 * Skill selection resolver for deterministic session skill sets.
 *
 * Computes which skills should be available in agent sessions based on:
 * 1. Project execution-enabled skill patterns from settings
 * 2. Optional caller-requested skill names (for per-task overrides)
 *
 * The resolver reads project settings files directly (read-only) and produces
 * a filter set used by createKbAgent's DefaultResourceLoader.skillsOverride.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResourceDiagnostic, Skill } from "@mariozechner/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * Context for skill selection resolution.
 */
export interface SkillSelectionContext {
  /**
   * Absolute path to the project root for reading settings.
   */
  projectRootDir: string;

  /**
   * Optional explicit skill names the caller wants (e.g., from task config).
   * These are skill names (not IDs), matched case-insensitively against Skill.name.
   */
  requestedSkillNames?: string[];

  /**
   * Diagnostic label for log messages (e.g., "executor", "triage", "reviewer").
   */
  sessionPurpose?: string;
}

/**
 * Diagnostic about a configured or requested skill.
 */
export interface SkillDiagnostic {
  type: "info" | "warning" | "error";
  message: string;
  skillName?: string;
  skillPath?: string;
}

/**
 * Result of skill selection resolution.
 */
export interface SkillSelectionResult {
  /**
   * Set of skill file paths to include in the session.
   * Used by skillsOverride to filter discovered skills.
   */
  allowedSkillPaths: Set<string>;

  /**
   * Diagnostics about configured/requested skills.
   */
  diagnostics: SkillDiagnostic[];

  /**
   * Whether filtering should be applied.
   * false = all discovered skills pass through (no patterns configured, no requested names)
   * true = skills are filtered according to allowedSkillPaths
   */
  filterActive: boolean;
}

/**
 * Project settings structure relevant to skill selection.
 */
interface ProjectSkillSettings {
  skills?: string[];
  packages?: Array<string | { source: string; skills?: string[] }>;
}

// ── Settings Reading ─────────────────────────────────────────────────────────

/**
 * Read a JSON object from a file path.
 * Returns empty object if file doesn't exist or is invalid.
 */
function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Read project settings from .fusion/settings.json with .pi/settings.json fallback.
 */
function readProjectSettings(projectRootDir: string): ProjectSkillSettings {
  const fusionSettings = join(projectRootDir, ".fusion", "settings.json");
  const legacySettings = join(projectRootDir, ".pi", "settings.json");

  // Try .fusion first, then .pi
  if (existsSync(fusionSettings)) {
    const parsed = readJsonObject(fusionSettings);
    // Only return skill-relevant fields
    return {
      skills: Array.isArray(parsed.skills) ? (parsed.skills as string[]) : undefined,
      packages: Array.isArray(parsed.packages) ? (parsed.packages as Array<string | { source: string; skills?: string[] }>) : undefined,
    };
  }

  if (existsSync(legacySettings)) {
    const parsed = readJsonObject(legacySettings);
    return {
      skills: Array.isArray(parsed.skills) ? (parsed.skills as string[]) : undefined,
      packages: Array.isArray(parsed.packages) ? (parsed.packages as Array<string | { source: string; skills?: string[] }>) : undefined,
    };
  }

  return {};
}

// ── Pattern Normalization ────────────────────────────────────────────────────

/**
 * Normalize a skill pattern by removing the + prefix (enabled by default).
 * Returns the path portion of the pattern.
 */
function normalizePattern(pattern: string): string {
  if (pattern.startsWith("+") || pattern.startsWith("-")) {
    return pattern.slice(1);
  }
  return pattern;
}

/**
 * Check if a pattern is an exclusion pattern (-prefixed).
 */
function isExclusionPattern(pattern: string): boolean {
  return pattern.startsWith("-");
}

// ── Main Resolution Logic ────────────────────────────────────────────────────

/**
 * Compute deterministic skill selection from project settings and optional requested names.
 *
 * Resolution rules:
 * 1. If NO skill patterns exist AND no requestedSkillNames → filterActive: false (all pass through)
 * 2. If skill patterns exist:
 *    - + prefix or no prefix = add to allowed set
 *    - - prefix = exclude from allowed set
 *    - Last entry wins for duplicate paths
 * 3. If requestedSkillNames provided:
 *    - Acts as additional intersection filter (skills must match name AND be in allowed set)
 *    - Case-insensitive matching against Skill.name
 * 4. Diagnostics produced for:
 *    - Patterns that don't match discovered skills (warning)
 *    - Requested names not matching any discovered skill (warning)
 */
export function resolveSessionSkills(context: SkillSelectionContext): SkillSelectionResult {
  const { projectRootDir, requestedSkillNames } = context;

  // Read project settings
  const settings = readProjectSettings(projectRootDir);

  // Collect all skill patterns from settings
  const skillPatterns: string[] = [];

  // Top-level skills patterns
  if (settings.skills) {
    for (const pattern of settings.skills) {
      if (typeof pattern === "string") {
        skillPatterns.push(pattern);
      }
    }
  }

  // Package-scoped skill patterns
  if (settings.packages) {
    for (const pkg of settings.packages) {
      if (typeof pkg === "object" && pkg !== null && "skills" in pkg && Array.isArray(pkg.skills)) {
        for (const pattern of pkg.skills) {
          if (typeof pattern === "string") {
            skillPatterns.push(pattern);
          }
        }
      }
    }
  }

  const hasPatterns = skillPatterns.length > 0;
  const hasRequestedNames = Boolean(requestedSkillNames && requestedSkillNames.length > 0);

  // If no patterns and no requested names, no filtering needed
  if (!hasPatterns && !hasRequestedNames) {
    return {
      allowedSkillPaths: new Set<string>(),
      diagnostics: [],
      filterActive: false,
    };
  }

  // Build allowed set from patterns
  // Last entry wins for duplicate paths: we track the "final decision" per path
  const finalDecisions = new Map<string, boolean>(); // true = allowed, false = excluded

  for (const pattern of skillPatterns) {
    const path = normalizePattern(pattern);
    const isExclusion = isExclusionPattern(pattern);
    finalDecisions.set(path, !isExclusion);
  }

  // Build allowed set from final decisions
  const allowedSet = new Set<string>();
  for (const [path, allowed] of finalDecisions) {
    if (allowed) {
      allowedSet.add(path);
    }
  }

  // Determine if filtering is active
  // filterActive is true when:
  // - Patterns exist (some skills are explicitly configured)
  // - OR only requested names are provided (filter to those names)
  const filterActive = hasPatterns || hasRequestedNames;

  // Produce diagnostics for patterns (we can't check against actual discovered skills here,
  // so we note which patterns are configured)
  const diagnostics: SkillDiagnostic[] = [];

  if (hasPatterns) {
    for (const pattern of skillPatterns) {
      if (!isExclusionPattern(pattern)) {
        // Note: We don't have access to discovered skills here to check if pattern matches
        // The actual validation happens in createSkillsOverrideFromSelection when base.skills is available
        const path = normalizePattern(pattern);
        diagnostics.push({
          type: "info",
          message: `Configured skill pattern: ${pattern}`,
          skillPath: path,
        });
      }
    }
  }

  if (hasRequestedNames) {
    for (const name of requestedSkillNames!) {
      diagnostics.push({
        type: "info",
        message: `Requested skill: ${name}`,
        skillName: name,
      });
    }
  }

  return {
    allowedSkillPaths: allowedSet,
    diagnostics,
    filterActive,
  };
}

// ── Skills Override Factory ─────────────────────────────────────────────────

/**
 * Options for skills override filtering.
 * We track requested names here so we can validate against base.skills.
 */
export interface SkillsOverrideOptions {
  /** Set of allowed skill paths */
  allowedSkillPaths: Set<string>;
  /** Whether filtering is active */
  filterActive: boolean;
  /** Requested skill names for diagnostic purposes */
  requestedSkillNames?: string[];
  /** Session purpose for log messages */
  sessionPurpose?: string;
}

/**
 * Create a skillsOverride callback compatible with DefaultResourceLoaderOptions.skillsOverride.
 *
 * @param selection - The skill selection result from resolveSessionSkills
 * @param options - Additional options for the override
 * @returns A skillsOverride callback for DefaultResourceLoader
 */
export function createSkillsOverrideFromSelection(
  selection: SkillSelectionResult,
  options: Omit<SkillsOverrideOptions, "allowedSkillPaths" | "filterActive"> = {},
): (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const { allowedSkillPaths, filterActive } = selection;
  const { requestedSkillNames, sessionPurpose } = options;

  return (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    // If filtering is not active, return base unchanged
    if (!filterActive) {
      return base;
    }

    // Determine the effective filter criteria
    // When requestedSkillNames is provided without patterns, filter by name
    // When patterns are provided, filter by file path
    const hasPatterns = allowedSkillPaths.size > 0;
    const hasRequestedNames = Boolean(requestedSkillNames && requestedSkillNames.length > 0);

    // Filter skills
    let filteredSkills: Skill[];
    if (hasRequestedNames) {
      // Filter by requested names (case-insensitive match)
      const requestedNamesLower = new Set(requestedSkillNames!.map((n) => n.toLowerCase()));
      filteredSkills = base.skills.filter((skill) => requestedNamesLower.has(skill.name.toLowerCase()));
    } else if (hasPatterns) {
      // Filter by file path
      filteredSkills = base.skills.filter((skill) => allowedSkillPaths.has(skill.filePath));
    } else {
      // No filter criteria - this shouldn't happen if filterActive is true
      filteredSkills = base.skills;
    }

    // Build diagnostics for missing skills
    const newDiagnostics: ResourceDiagnostic[] = [];

    // Check for configured patterns that don't match any discovered skill
    // Note: At this point, we have access to base.skills for validation
    const purpose = sessionPurpose ? ` [${sessionPurpose}]` : "";
    for (const allowedPath of allowedSkillPaths) {
      const hasMatch = base.skills.some((skill) => skill.filePath === allowedPath);
      if (!hasMatch) {
        newDiagnostics.push({
          type: "warning",
          message: `Configured skill pattern '${allowedPath}' not found in discovered skills${purpose}`,
          path: allowedPath,
        });
      }
    }

    // Check for requested names that don't match any discovered skill
    if (requestedSkillNames) {
      const discoveredNamesLower = new Set(base.skills.map((s) => s.name.toLowerCase()));
      for (const requestedName of requestedSkillNames) {
        if (!discoveredNamesLower.has(requestedName.toLowerCase())) {
          const purpose = sessionPurpose ? ` [${sessionPurpose}]` : "";
          newDiagnostics.push({
            type: "warning",
            message: `Requested skill '${requestedName}' not found in discovered skills${purpose}`,
          });
        }
      }
    }

    // Log diagnostics if any
    if (newDiagnostics.length > 0) {
      const purpose = sessionPurpose ? `[${sessionPurpose}]` : "skills";
      for (const diag of newDiagnostics) {
        console.error(`[pi] [skills] ${diag.type}: ${diag.message}`);
      }
    }

    return {
      skills: filteredSkills,
      diagnostics: [...base.diagnostics, ...newDiagnostics],
    };
  };
}
