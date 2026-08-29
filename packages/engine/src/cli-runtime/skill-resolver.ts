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
import { getProjectRootFromWorktree, normalizeStoredSkillPath } from "@fusion/core";
import { piLog } from "../logger.js";

// ── Project Root Resolution ──────────────────────────────────────────────────

/**
 * Resolve the project root directory by preferring the parent repo when
 * `cwd` is inside a `.worktrees/<name>/...` path, then falling back to the
 * legacy `.fusion` ancestor walk.
 *
 * Falls back to `cwd` if no `.fusion/` directory is found (mirrors
 * `resolvePiExtensionProjectRoot` from `@fusion/core`).
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-30-13:20 (U11 census hygiene):
`"triage"` HERE IS A SESSION PURPOSE — which agent role is running — NOT a board
column. It matched the `=== "triage"` census only because it is the same word, and
resolving it from a workflow's IR would be wrong: an agent role does not move when
a board renames its planning column.

Hoisted to a named set so the four role purposes read as one concept and the
literal stops looking like a lifecycle guard.
*/
const ROLE_FALLBACK_SESSION_PURPOSES: ReadonlySet<string> = new Set([
  "triage",
  "executor",
  "reviewer",
  "merger",
]);

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
   * Names that must be read before work when they survive project settings.
   * Unlike requestedSkillNames, these are intent only and never restrict discovery.
   */
  forcedSkillNames?: string[];

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
 * Return the canonical body path beneath a discovered skill's `skills/` root.
 * A path without that root is only eligible for exact filePath matching.
 */
function skillBodyRelativePath(filePath: string): string | undefined {
  const normalizedFilePath = filePath.replaceAll("\\", "/");
  const lowerCasePath = normalizedFilePath.toLowerCase();
  const segmentIndex = lowerCasePath.lastIndexOf("/skills/");

  if (segmentIndex >= 0) {
    return normalizedFilePath.slice(segmentIndex + "/skills/".length);
  }
  if (lowerCasePath.startsWith("skills/")) {
    return normalizedFilePath.slice("skills/".length);
  }
  return undefined;
}

/**
 * FNXC:SkillResolution 2026-07-21-00:00:
 * GitHub #2385 / FN-8465 requires session filtering to use the same skills-relative body-path identity as the Skills view. Legacy `-name/SKILL.md` entries must not suppress a re-categorized `skills/category/name/SKILL.md` body merely because pi exposes the same bare Skill.name.
 */
function skillMatchesExecutionPattern(skill: Skill, pattern: string): boolean {
  if (skill.filePath === pattern) {
    return true;
  }

  const bodyRelativePath = skillBodyRelativePath(skill.filePath);
  return bodyRelativePath !== undefined
    && normalizeStoredSkillPath(bodyRelativePath).toLowerCase()
      === normalizeStoredSkillPath(pattern).toLowerCase();
}

/**
 * FNXC:SkillResolution 2026-07-21-00:00:
 * Legacy flat `+name/SKILL.md` keys must be ignored as well as legacy disables.
 * Otherwise an unmatched stale allow key activates the session allow-list and
 * suppresses re-categorized skills even though the Skills view shows them enabled.
 */
function isLegacyFlatPatternForNestedSkill(skill: Skill, pattern: string): boolean {
  const bodyRelativePath = skillBodyRelativePath(skill.filePath);
  if (!bodyRelativePath) return false;

  const bodySegments = normalizeStoredSkillPath(bodyRelativePath)
    .toLowerCase()
    .split("/");
  const patternSegments = normalizeStoredSkillPath(pattern)
    .toLowerCase()
    .split("/");

  return bodySegments.length > 2
    && patternSegments.length === 2
    && bodySegments.at(-2) === patternSegments[0]
    && bodySegments.at(-1) === patternSegments[1];
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
  const { requestedSkillNames, forcedSkillNames } = context;

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
  const hasForcedNames = Boolean(forcedSkillNames && forcedSkillNames.length > 0);

  // If no patterns and no requested names, no filtering needed
  if (!hasPatterns && !hasRequestedNames && !hasForcedNames) {
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
  const filterActive = hasPatterns || hasRequestedNames || hasForcedNames;

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
  /** Ensure-present names; they never narrow the discovered set. */
  requestedSkillNames?: string[];
  /** Forced read-first names, resolved only after final filtering. */
  forcedSkillNames?: string[];
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
export interface ResolvedForcedSkill {
  requestedName: string;
  skillName: string;
}

export interface UnresolvedForcedSkill {
  requestedName: string;
  reason: "disabled-by-settings" | "not-found";
}

export interface SkillsOverrideResult {
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
  resolvedForcedSkills: ResolvedForcedSkill[];
  unresolvedForcedSkills: UnresolvedForcedSkill[];
}

/*
FNXC:SkillResolution 2026-08-16-03:19:
GitHub #1422 requires project enablement to decide availability for every agent.
Per-agent and workflow names are additive forced-read intent: exclusions win, and
only names resolved in the final session set may be ordered in a prompt.
*/
export function createSkillsOverrideFromSelection(
  selection: SkillSelectionResult,
  options: Omit<SkillsOverrideOptions, "allowedSkillPaths" | "filterActive"> = {},
): (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => SkillsOverrideResult {
  const { allowedSkillPaths, excludedSkillPaths, filterActive } = selection;
  const { requestedSkillNames, forcedSkillNames, sessionPurpose } = options;
  const isBuiltInFallbackRequest = (name: string): boolean =>
    ROLE_FALLBACK_SESSION_PURPOSES.has(sessionPurpose ?? "") && name.toLowerCase() === "fusion";

  return (base) => {
    // FNXC:SkillResolution 2026-08-16-03:42: Even an unfiltered session must
    // return explicit forced-resolution channels. The shared prompt seam and
    // session summary consume this result for every lane, including heartbeat.
    if (!filterActive && !(forcedSkillNames?.length)) {
      return {
        skills: base.skills,
        diagnostics: base.diagnostics,
        resolvedForcedSkills: [],
        unresolvedForcedSkills: [],
      };
    }
    const effectiveAllowed = new Set([...allowedSkillPaths].filter((pattern) => !base.skills.some(
      (skill) => isLegacyFlatPatternForNestedSkill(skill, pattern),
    )));
    const isExcluded = (skill: Skill) => [...excludedSkillPaths].some((path) => skillMatchesExecutionPattern(skill, path));
    const isAllowed = (skill: Skill) => [...effectiveAllowed].some((path) => skillMatchesExecutionPattern(skill, path));
    const hasExcluded = excludedSkillPaths.size > 0;

    // Patterns establish the base availability. Requested names only ensure a
    // discovered skill is included; they are no longer an allow-list.
    const skills = !filterActive ? base.skills : effectiveAllowed.size > 0
      ? base.skills.filter((skill) => isAllowed(skill) && !isExcluded(skill))
      : hasExcluded ? base.skills.filter((skill) => !isExcluded(skill)) : base.skills;
    const ensureNames = [...(requestedSkillNames ?? []), ...(forcedSkillNames ?? [])];
    for (const name of ensureNames) {
      const matching = base.skills.filter((skill) => requestedSkillMatchKey(skill.name) === requestedSkillMatchKey(name));
      for (const skill of matching) if (!isExcluded(skill) && !skills.includes(skill)) skills.push(skill);
    }

    const diagnostics: ResourceDiagnostic[] = [];
    const unresolvedForcedSkills: UnresolvedForcedSkill[] = [];
    const resolvedForcedSkills: ResolvedForcedSkill[] = [];
    const seenForced = new Set<string>();
    for (const requestedName of forcedSkillNames ?? []) {
      const key = requestedSkillMatchKey(requestedName);
      if (!key || seenForced.has(key)) continue;
      seenForced.add(key);
      const matches = base.skills.filter((skill) => requestedSkillMatchKey(skill.name) === key);
      const resolved = matches.find((skill) => skills.includes(skill));
      if (resolved) resolvedForcedSkills.push({ requestedName, skillName: resolved.name });
      else if (matches.some(isExcluded)) {
        unresolvedForcedSkills.push({ requestedName, reason: "disabled-by-settings" });
        diagnostics.push({ type: "warning" as ResourceDiagnostic["type"], message: `Forced skill '${requestedName}' stays disabled by project settings`, path: requestedName });
      } else {
        unresolvedForcedSkills.push({ requestedName, reason: "not-found" });
        diagnostics.push({ type: "info" as ResourceDiagnostic["type"], message: `Requested skill '${requestedName}' not found in discovered skills` });
      }
    }
    for (const path of effectiveAllowed) {
      if (!base.skills.some((skill) => skillMatchesExecutionPattern(skill, path))) {
        diagnostics.push({ type: "info" as ResourceDiagnostic["type"], message: `Configured skill pattern '${path}' not found in discovered skills${sessionPurpose ? ` [${sessionPurpose}]` : ""}`, path });
      }
    }
    for (const path of excludedSkillPaths) {
      if (base.skills.some((skill) => skillMatchesExecutionPattern(skill, path))) {
        diagnostics.push({ type: "info" as ResourceDiagnostic["type"], message: `Skill at '${path}' exists but is disabled by project execution settings`, path });
      }
    }
    for (const name of requestedSkillNames ?? []) {
      if (!base.skills.some((skill) => requestedSkillMatchKey(skill.name) === requestedSkillMatchKey(name)) && !isBuiltInFallbackRequest(name)) {
        diagnostics.push({ type: "info" as ResourceDiagnostic["type"], message: `Requested skill '${name}' not found in discovered skills${sessionPurpose ? ` [${sessionPurpose}]` : ""}` });
      }
    }
    for (const diagnostic of diagnostics) {
      const message = `[skills] ${diagnostic.type}: ${diagnostic.message}`;
      if (diagnostic.type === "warning") piLog.warn(message);
      else piLog.debug(message);
    }
    const purpose = sessionPurpose ?? "skills";
    const unavailable = unresolvedForcedSkills.length
      ? `; forced-unavailable: [${unresolvedForcedSkills.map((entry) => `${entry.requestedName} (${entry.reason})`).join(", ")}]` : "";
    piLog.log(`[skills] [${purpose}] ${skills.length} skill(s) available; forced: ${resolvedForcedSkills.length ? `[${resolvedForcedSkills.map((entry) => entry.skillName).join(", ")}]` : "none"}${unavailable}`);
    return { skills, diagnostics: [...base.diagnostics, ...diagnostics], resolvedForcedSkills, unresolvedForcedSkills };
  };
}

