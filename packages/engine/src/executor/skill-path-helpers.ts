/**
 * FNXC:CodeOrganization 2026-08-03-07:45:
 * Workflow skill discovery helpers peeled from executor.ts (U4 pure peels).
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";

export function mergeAdditionalSkillPaths(...pathGroups: Array<string[] | undefined>): string[] | undefined {
  const merged = Array.from(new Set(pathGroups.flatMap((paths) => paths ?? [])));
  return merged.length > 0 ? merged : undefined;
}

/**
 * FNXC:WorkflowSteps 2026-07-30-21:40:
 * FN-8461 / GitHub #2388 require workflow skill-load warnings to describe a true
 * named-skill delivery failure, not an optional Compound Engineering source being
 * absent. Plugin body directories are paired with their parent discovery roots,
 * so check the requested bare name against each merged source; unrelated paths
 * must never hide a missing requested skill.
 */
export function isWorkflowStepSkillDiscoverable(
  skillName: string,
  additionalSkillPaths: string[] | undefined,
  ceSkillsDir: string | undefined,
): boolean {
  // A configured CE root remains a viable source by contract: deployments can
  // inject a synthetic install root before its skill tree is materialized locally.
  if (ceSkillsDir) return true;

  const bareSkillName = skillName.includes(":")
    ? skillName.slice(skillName.lastIndexOf(":") + 1)
    : skillName;
  if (!bareSkillName || basename(bareSkillName) !== bareSkillName || bareSkillName === "." || bareSkillName === "..") {
    return false;
  }

  return (additionalSkillPaths ?? []).some((skillPath) =>
    (basename(skillPath) === bareSkillName && existsSync(join(skillPath, "SKILL.md")))
    || existsSync(join(skillPath, bareSkillName, "SKILL.md")),
  );
}
