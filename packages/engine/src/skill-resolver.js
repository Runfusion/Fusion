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
import { join } from "node:path";
import { piLog } from "./logger.js";
// ── Settings Reading ─────────────────────────────────────────────────────────
/**
 * Read a JSON object from a file path.
 * Returns empty object if file doesn't exist or is invalid.
 */
function readJsonObject(path) {
    if (!existsSync(path)) {
        return {};
    }
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
/**
 * Read project settings from .fusion/settings.json.
 */
function readProjectSettings(projectRootDir) {
    const fusionSettings = join(projectRootDir, ".fusion", "settings.json");
    if (existsSync(fusionSettings)) {
        const parsed = readJsonObject(fusionSettings);
        // Only return skill-relevant fields
        return {
            skills: Array.isArray(parsed.skills) ? parsed.skills : undefined,
            packages: Array.isArray(parsed.packages) ? parsed.packages : undefined,
        };
    }
    return {};
}
// ── Pattern Normalization ────────────────────────────────────────────────────
/**
 * Normalize a skill pattern by removing the + prefix (enabled by default).
 * Returns the path portion of the pattern.
 */
function normalizePattern(pattern) {
    if (pattern.startsWith("+") || pattern.startsWith("-")) {
        return pattern.slice(1);
    }
    return pattern;
}
/**
 * Check if a pattern is an exclusion pattern (-prefixed).
 */
function isExclusionPattern(pattern) {
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
export function resolveSessionSkills(context) {
    const { projectRootDir, requestedSkillNames } = context;
    // Read project settings
    const settings = readProjectSettings(projectRootDir);
    // Collect all skill patterns from settings
    const skillPatterns = [];
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
            allowedSkillPaths: new Set(),
            excludedSkillPaths: new Set(),
            diagnostics: [],
            filterActive: false,
        };
    }
    // Build allowed and excluded sets from patterns
    // Last entry wins for duplicate paths: we track the "final decision" per path
    const finalDecisions = new Map(); // true = allowed, false = excluded
    for (const pattern of skillPatterns) {
        const path = normalizePattern(pattern);
        const isExclusion = isExclusionPattern(pattern);
        finalDecisions.set(path, !isExclusion);
    }
    // Build allowed and excluded sets from final decisions
    const allowedSet = new Set();
    const excludedSet = new Set();
    for (const [path, allowed] of finalDecisions) {
        if (allowed) {
            allowedSet.add(path);
        }
        else {
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
    const diagnostics = [];
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
        for (const name of requestedSkillNames) {
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
/**
 * Create a skillsOverride callback compatible with DefaultResourceLoaderOptions.skillsOverride.
 *
 * @param selection - The skill selection result from resolveSessionSkills
 * @param options - Additional options for the override
 * @returns A skillsOverride callback for DefaultResourceLoader
 */
export function createSkillsOverrideFromSelection(selection, options = {}) {
    const { allowedSkillPaths, excludedSkillPaths, filterActive } = selection;
    const { requestedSkillNames, sessionPurpose } = options;
    return (base) => {
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
        let filteredSkills;
        if (hasRequestedNames) {
            // Filter by requested names (case-insensitive match)
            const requestedNamesLower = new Set(requestedSkillNames.map((n) => n.toLowerCase()));
            filteredSkills = base.skills.filter((skill) => requestedNamesLower.has(skill.name.toLowerCase()) && !excludedSkillPaths.has(skill.filePath));
        }
        else if (hasPatterns) {
            // Filter by file path (in allowed set AND not in excluded set)
            filteredSkills = base.skills.filter((skill) => allowedSkillPaths.has(skill.filePath) && !excludedSkillPaths.has(skill.filePath));
        }
        else if (hasExcluded) {
            // Only exclusions set - filter out excluded skills
            filteredSkills = base.skills.filter((skill) => !excludedSkillPaths.has(skill.filePath));
        }
        else {
            // No filter criteria - this shouldn't happen if filterActive is true
            filteredSkills = base.skills;
        }
        // Build diagnostics for missing and disabled skills
        const newDiagnostics = [];
        // Check for excluded paths that DO match a discovered skill (disabled)
        // These are skills that exist but were explicitly excluded by project patterns
        const purpose = sessionPurpose ? ` [${sessionPurpose}]` : "";
        const discoveredPaths = new Set(base.skills.map((s) => s.filePath));
        for (const excludedPath of excludedSkillPaths) {
            if (discoveredPaths.has(excludedPath)) {
                // Skill exists but was disabled by project patterns
                // Use "warning" type since ResourceDiagnostic only supports warning|error|collision
                newDiagnostics.push({
                    type: "warning",
                    message: `Skill at '${excludedPath}' exists but is disabled by project execution settings${purpose}`,
                    path: excludedPath,
                });
            }
            // If the path doesn't match any discovered skill, it's not a disabled skill - it's just not relevant
        }
        // Check for configured patterns (allowed paths) that don't match any discovered skill
        // Note: At this point, we have access to base.skills for validation
        for (const allowedPath of allowedSkillPaths) {
            if (!discoveredPaths.has(allowedPath)) {
                // Allowed path doesn't match any discovered skill - this is a missing/invalid pattern
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
            const _purpose = sessionPurpose ? `[${sessionPurpose}]` : "skills";
            for (const diag of newDiagnostics) {
                piLog.warn(`[skills] ${diag.type}: ${diag.message}`);
            }
        }
        return {
            skills: filteredSkills,
            diagnostics: [...base.diagnostics, ...newDiagnostics],
        };
    };
}
//# sourceMappingURL=skill-resolver.js.map