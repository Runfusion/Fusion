/**
 * Skill selection resolver for deterministic session skill sets.
 *
 * Computes which skills should be available in agent sessions based on:
 * 1. Project execution-enabled skill patterns from settings
 * 2. Optional caller-requested skill names (for per-task overrides)
 *
 * The resolver reads project settings files directly (read-only) and produces
 * a filter set used by createFnAgent's DefaultResourceLoader.skillsOverride.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResourceDiagnostic, Skill } from "@earendil-works/pi-coding-agent";
import { getProjectRootFromWorktree } from "@fusion/core";
import { piLog } from "./logger.js";

// ── Project Root Resolution ──────────────────────────────────────────────────

/**
 * Resolve the project root directory by preferring the parent repo when
 * `cwd` is inside a `.worktrees/<name>/...` path, then falling back to the
 * legacy `.fusion` ancestor walk.
 *
 * Falls back to `cwd` if no `.fusion/` directory is found (mirrors
 * `resolvePiExtensionProjectRoot` from `@fusion/core`).
 */
export function resolveProjectRoot(cwd: string): string {
  const worktreeProjectRoot = getProjectRootFromWorktree(cwd);
  if (worktreeProjectRoot && existsSync(join(worktreeProjectRoot, ".fusion"))) {
    return worktreeProjectRoot;
  }

  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".fusion"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(cwd);
    }
    current = parent;
  }
}

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
   * Set of skill file paths that were explicitly excluded by project patterns.
   * These paths were disabled via -prefix patterns.
   * Used by skillsOverride to distinguish "disabled" (exists but excluded) from "missing" (doesn't exist).
   */
  excludedSkillPaths: Set<string>;

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
export interface ProjectSkillSettings {
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
 * Read project settings from .fusion/settings.json.
 */
export function readProjectSettings(projectRootDir: string): ProjectSkillSettings {
  const fusionSettings = join(projectRootDir, ".fusion", "settings.json");

  if (existsSync(fusionSettings)) {
    const parsed = readJsonObject(fusionSettings);
    // Only return skill-relevant fields
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

/**
 * Extract the bare skill name for matching purposes.
 *
 * Fusion conventions use two-segment names like "web-research/SKILL.md" (from
 * extractSkillName and normalizeAgentSkills), but pi-coding-agent sets Skill.name
 * to just the parent directory (e.g. "web-research"). This helper strips common
 * suffixes so both sides can be compared:
 *
 *   "web-research/SKILL.md"           → "web-research"
 *   "skills/web-research/SKILL.md"    → "web-research"
 *   "web-research"                    → "web-research"
 *   "/abs/path/skills/web-research/SKILL.md" → left unchanged (absolute paths
 *     are matched by filePath comparison, not by this helper)
 */
function bareSkillName(name: string): string {
  return name.replace(/\/SKILL\.md$/i, "");
}

/**
 * FNXC:SkillResolution 2026-06-26-00:00:
 * Requested skills can arrive from chat and agent metadata as `gamma`, `review/pr`, `review/pr/SKILL.md`, or `source::skills/review/pr/SKILL.md` while discovered Skill.name entries are keyed by the bare token.
 * Reduce only requested-name comparisons to the dashboard bareSkillName convention so slash/namespaced requests load without changing allow/exclude path matching, which still depends on bareSkillName plus filePath equality.
 */
function requestedSkillMatchKey(name: string): string {
  if (!name) return "";
  const withoutSkillMd = name.replace(/\/SKILL\.md$/i, "");
  const lastPathSegment = withoutSkillMd.split("/").pop() ?? withoutSkillMd;
  const afterNamespace = lastPathSegment.split(":").pop() ?? lastPathSegment;
  return afterNamespace.toLowerCase();
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
  const { requestedSkillNames } = context;

  // Resolve project root from the given projectRootDir — it may be a
  // worktree path (e.g., /project/.worktrees/task-branch) which doesn't
  // contain .fusion/settings.json. Walk up to find the real project root.
  const projectRootDir = resolveProjectRoot(context.projectRootDir);

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
      excludedSkillPaths: new Set<string>(),
      diagnostics: [],
      filterActive: false,
    };
  }

  // Build allowed and excluded sets from patterns
  // Last entry wins for duplicate paths: we track the "final decision" per path
  const finalDecisions = new Map<string, boolean>(); // true = allowed, false = excluded

  for (const pattern of skillPatterns) {
    const path = normalizePattern(pattern);
    const isExclusion = isExclusionPattern(pattern);
    finalDecisions.set(path, !isExclusion);
  }

  // Build allowed and excluded sets from final decisions
  const allowedSet = new Set<string>();
  const excludedSet = new Set<string>();
  for (const [path, allowed] of finalDecisions) {
    if (allowed) {
      allowedSet.add(path);
    } else {
      excludedSet.add(path);
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
    excludedSkillPaths: excludedSet,
    diagnostics,
    filterActive,
  };
}

// ── Skills Override Factory ─────────────────────────────────────────────────

/*
FNXC:SkillResolution 2026-06-29-12:30:
Configured allow-list misses such as ce-optimize/SKILL.md are common when optional skills are absent from a checkout.
Keep the ResourceDiagnostic for programmatic visibility, but classify it separately so override application never mirrors this non-actionable info into piLog or console output.
*/
function isMissingConfiguredPatternDiagnostic(diag: ResourceDiagnostic): boolean {
  const diagnosticType = diag.type as string;
  return diagnosticType === "info"
    && diag.message.startsWith("Configured skill pattern '")
    && diag.message.includes("' not found in discovered skills");
}

/**
 * Options for skills override filtering.
 * We track requested names here so we can validate against base.skills.
 */
export interface SkillsOverrideOptions {
  /** Set of allowed skill paths */
  allowedSkillPaths: Set<string>;
  /** Set of explicitly excluded skill paths (from -patterns). If not provided, defaults to empty set. */
  excludedSkillPaths?: Set<string>;
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
  const { allowedSkillPaths, excludedSkillPaths, filterActive } = selection;
  const { requestedSkillNames, sessionPurpose } = options;

  const isBuiltInFallbackRequest = (name: string): boolean => {
    const purposeUsesRoleFallback = sessionPurpose === "triage"
      || sessionPurpose === "executor"
      || sessionPurpose === "reviewer"
      || sessionPurpose === "merger";
    return purposeUsesRoleFallback
      && requestedSkillNames?.length === 1
      && name.toLowerCase() === "fusion";
  };

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
    // Skills must match the inclusion criteria AND not be in the exclusion list
    const hasExcluded = excludedSkillPaths.size > 0;
    let filteredSkills: Skill[];
    // Build a name-based lookup for pattern/exclusion matching.
    // Settings patterns are relative (e.g. "web-research/SKILL.md") but
    // skill.filePath is absolute. Match against skill.name instead so
    // that patterns written by toggleExecutionSkill() actually resolve.
    //
    // pi-coding-agent sets Skill.name to the parent directory name
    // (e.g. "web-research") while Fusion uses two-segment names
    // (e.g. "web-research/SKILL.md"). bareSkillName() normalizes
    // both sides so the comparison succeeds.
    const skillNameMatches = (skill: Skill, pattern: string): boolean =>
      bareSkillName(skill.name).toLowerCase() === bareSkillName(pattern).toLowerCase()
      || skill.filePath === pattern;
    const isExcluded = (skill: Skill): boolean => {
      for (const ep of excludedSkillPaths) {
        if (skillNameMatches(skill, ep)) return true;
      }
      return false;
    };
    const isAllowed = (skill: Skill): boolean => {
      for (const ap of allowedSkillPaths) {
        if (skillNameMatches(skill, ap)) return true;
      }
      return false;
    };

    if (hasRequestedNames) {
      // Filter by requested names using the chat/dashboard bare-token convention only for requested-name matching.
      const requestedMatchKeys = new Set(requestedSkillNames!.map(requestedSkillMatchKey));
      filteredSkills = base.skills.filter(
        (skill) => requestedMatchKeys.has(requestedSkillMatchKey(skill.name)) && !isExcluded(skill)
      );
    } else if (hasPatterns) {
      // Filter by pattern (allowed AND not excluded)
      filteredSkills = base.skills.filter(
        (skill) => isAllowed(skill) && !isExcluded(skill)
      );
    } else if (hasExcluded) {
      // Only exclusions set - filter out excluded skills
      filteredSkills = base.skills.filter((skill) => !isExcluded(skill));
    } else {
      // No filter criteria - this shouldn't happen if filterActive is true
      filteredSkills = base.skills;
    }

    // Build diagnostics for missing and disabled skills
    const newDiagnostics: ResourceDiagnostic[] = [];

    // Check for excluded paths that DO match a discovered skill (disabled)
    const purpose = sessionPurpose ? ` [${sessionPurpose}]` : "";
    const discoveredBareNames = new Set(base.skills.map((s) => bareSkillName(s.name).toLowerCase()));
    const discoveredFilePaths = new Set(base.skills.map((s) => s.filePath));
    const hasDiscoveredMatch = (pattern: string): boolean =>
      discoveredBareNames.has(bareSkillName(pattern).toLowerCase()) || discoveredFilePaths.has(pattern);

    for (const excludedPath of excludedSkillPaths) {
      if (hasDiscoveredMatch(excludedPath)) {
        newDiagnostics.push({
          type: "warning",
          message: `Skill at '${excludedPath}' exists but is disabled by project execution settings${purpose}`,
          path: excludedPath,
        });
      }
    }

    // Check for configured patterns (allowed paths) that don't match any discovered skill
    for (const allowedPath of allowedSkillPaths) {
      if (!hasDiscoveredMatch(allowedPath)) {
        newDiagnostics.push({
          type: "info" as ResourceDiagnostic["type"],
          message: `Configured skill pattern '${allowedPath}' not found in discovered skills${purpose}`,
          path: allowedPath,
        });
      }
    }

    // Check for requested names that don't match any discovered skill
    if (requestedSkillNames) {
      const discoveredRequestedMatchKeys = new Set(base.skills.map((s) => requestedSkillMatchKey(s.name)));
      for (const requestedName of requestedSkillNames) {
        if (
          !discoveredRequestedMatchKeys.has(requestedSkillMatchKey(requestedName))
          && !isBuiltInFallbackRequest(requestedName)
        ) {
          const purpose = sessionPurpose ? ` [${sessionPurpose}]` : "";
          newDiagnostics.push({
            type: "info" as ResourceDiagnostic["type"],
            message: `Requested skill '${requestedName}' not found in discovered skills${purpose}`,
          });
        }
      }
    }

    // Log diagnostics if any
    if (newDiagnostics.length > 0) {
      const _purpose = sessionPurpose ? `[${sessionPurpose}]` : "skills";
      for (const diag of newDiagnostics) {
        if (isMissingConfiguredPatternDiagnostic(diag)) continue;
        const msg = `[skills] ${diag.type}: ${diag.message}`;
        if (diag.type === "error") piLog.error(msg);
        else if (diag.type === "warning") piLog.warn(msg);
        else piLog.log(msg);
      }
    }

    return {
      skills: filteredSkills,
      diagnostics: [...base.diagnostics, ...newDiagnostics],
    };
  };
}

