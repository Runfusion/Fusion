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
import type { ResourceDiagnostic, Skill } from "@mariozechner/pi-coding-agent";
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
export declare function resolveSessionSkills(context: SkillSelectionContext): SkillSelectionResult;
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
export declare function createSkillsOverrideFromSelection(selection: SkillSelectionResult, options?: Omit<SkillsOverrideOptions, "allowedSkillPaths" | "filterActive">): (base: {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
}) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
};
//# sourceMappingURL=skill-resolver.d.ts.map