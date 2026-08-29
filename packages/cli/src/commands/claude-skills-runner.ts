/**
 * Thin wrapper around claude-skills install logic that also handles the
 * "should we even try?" question (reads global settings, checks detection)
 * so call sites don't each repeat that plumbing.
 */

import { getPackageManagerAgentDir } from "./auth-paths.js";
import {
  ensureShippedSkillsForProjects,
  installShippedSkillsIntoProject,
  SHIPPED_SKILL_NAMES,
  isPiClaudeCliConfigured,
  resolveShippedSkillSource,
  type InstallResult,
  type ShippedSkillName,
} from "./claude-skills.js";
import { createReadOnlyProviderSettingsView } from "./provider-settings.js";

/**
 * Resolve whether pi-claude-cli is configured by reading the user's global
 * settings (`~/.fusion/agent/settings.json` with cascade to legacy `.pi`).
 *
 * The project path is used only so the settings reader can merge the
 * project's `.fusion/settings.json` overlay; we only examine the global
 * portion for this check.
 */
export function detectPiClaudeCli(projectPath: string): boolean {
  try {
    const agentDir = getPackageManagerAgentDir();
    const view = createReadOnlyProviderSettingsView(projectPath, agentDir);
    return isPiClaudeCliConfigured(view.getGlobalSettings());
  } catch {
    return false;
  }
}

/**
 * Install every shipped skill into a single newly-created project, logging the
 * outcome to the console. Intended for CLI entry points (`fn init`,
 * `fn project add`) where the user is watching the output.
 *
 * No-op (and silent) when pi-claude-cli is not configured so the file layout
 * stays clean for users who only use direct Anthropic API.
 */
export function maybeInstallClaudeSkillForNewProject(projectPath: string): InstallResult[] {
  /* FNXC:ComputerUseSkill 2026-08-11-07:32: Every shipped skill must retain its own outcome and
   * log label so a computer-use failure cannot be misreported as a fusion-skill failure. */
  const enabled = detectPiClaudeCli(projectPath);
  const results = installShippedSkillsIntoProject(projectPath, { enabled });
  for (const [index, result] of results.entries()) logInstallResult(result, SHIPPED_SKILL_NAMES[index]!, { verbose: enabled });
  return results;
}

/**
 * Install the fusion skill into every registered project during server
 * startup. Non-blocking: callers invoke this without awaiting. Logs one line
 * per non-skipped, non-already-installed project; stays quiet when there's
 * nothing to do.
 */
export function ensureClaudeSkillsForAllProjectsOnStartup(
  projects: Array<{ id: string; name: string; path: string }>,
  options: {
    /** Test seam; production callers retain global pi-claude-cli detection. */
    enabled?: boolean;
    /** Test seam for isolated packaged-skill sources. */
    sources?: Partial<Record<ShippedSkillName, string | null>>;
  } = {},
): InstallResult[] {
  if (projects.length === 0) return [];
  // Detect using the first project; all share the same user-level settings.
  const enabled = options.enabled ?? detectPiClaudeCli(projects[0]!.path);
  const sources = enabled
    ? options.sources ?? Object.fromEntries(SHIPPED_SKILL_NAMES.map((name) => [name, resolveShippedSkillSource(name)]))
    : undefined;
  const results = ensureShippedSkillsForProjects(projects, { enabled, sources });
  for (let i = 0; i < results.length; i++) {
    const result = results[i]!;
    if (result.outcome === "installed" || result.outcome === "replaced") {
      console.log(
        `[fusion] Installed ${SHIPPED_SKILL_NAMES[i % SHIPPED_SKILL_NAMES.length]} Claude skill for project '${projects[Math.floor(i / SHIPPED_SKILL_NAMES.length)]!.name}' (${result.outcome}): ${result.target}`,
      );
    } else if (result.outcome === "failed") {
      console.warn(
        `[fusion] Could not install ${SHIPPED_SKILL_NAMES[i % SHIPPED_SKILL_NAMES.length]} Claude skill for project '${projects[Math.floor(i / SHIPPED_SKILL_NAMES.length)]!.name}': ${result.reason ?? "unknown error"}`,
      );
    }
  }
  return results;
}

function logInstallResult(result: InstallResult, skillName: string, options: { verbose: boolean }): void {
  switch (result.outcome) {
    case "installed":
      console.log(`  ✓ Installed ${skillName} skill at ${result.target}`);
      break;
    case "replaced":
      console.log(`  ✓ Refreshed ${skillName} skill at ${result.target}`);
      break;
    case "already-installed":
      if (options.verbose) {
        console.log(`  ✓ ${skillName} skill already present at ${result.target}`);
      }
      break;
    case "failed":
      console.warn(
        `  ⚠ Could not install ${skillName} skill: ${result.reason ?? "unknown error"}`,
      );
      break;
    case "skipped":
      // Silent — the user hasn't opted into Claude Code routing.
      break;
  }
}
