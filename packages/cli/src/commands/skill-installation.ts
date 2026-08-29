import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FUSION_SKILL_NAME = "fusion";
export const SHIPPED_SKILL_NAMES = [FUSION_SKILL_NAME, "computer-use"] as const;

export type SupportedSkillClient = "claude" | "codex" | "gemini";

export interface SkillInstallTarget {
  skillName: string;
  client: SupportedSkillClient;
  targetDir: string;
}

export type SkillInstallOutcome = "installed" | "skipped" | "warning";

export interface SkillInstallResult {
  client: SupportedSkillClient;
  targetDir: string;
  outcome: SkillInstallOutcome;
  reason?: string;
}

export interface InstallBundledFusionSkillResult {
  sourceDir: string | null;
  results: SkillInstallResult[];
}

export function getSupportedSkillInstallTargets(
  homeDir = process.env.HOME || process.env.USERPROFILE || homedir(),
): SkillInstallTarget[] {
  return SHIPPED_SKILL_NAMES.flatMap((skillName) => [
    { skillName, client: "claude" as const, targetDir: join(homeDir, ".claude", "skills", skillName) },
    { skillName, client: "codex" as const, targetDir: join(homeDir, ".codex", "skills", skillName) },
    { skillName, client: "gemini" as const, targetDir: join(homeDir, ".gemini", "skills", skillName) },
  ]);
}

export function resolveBundledShippedSkillSource(skillName: string): string | null {
  const here = fileURLToPath(import.meta.url);
  const source = resolve(dirname(here), "..", "..", "skill", skillName);
  return existsSync(source) ? source : null;
}
export function resolveBundledFusionSkillSource(): string | null { return resolveBundledShippedSkillSource(FUSION_SKILL_NAME); }

/** Install every declared bundled skill into supported agent homes. */
export function installBundledShippedSkills(options: {
  homeDir?: string;
  sourceDir?: string | null;
} = {}): InstallBundledFusionSkillResult {
  const sourceDir = options.sourceDir ?? resolveBundledFusionSkillSource();
  const targets = getSupportedSkillInstallTargets(options.homeDir);
  const results = targets.map<SkillInstallResult>((target) => {
    const source = target.skillName === FUSION_SKILL_NAME ? sourceDir : resolveBundledShippedSkillSource(target.skillName);
    if (!source) return { client: target.client, targetDir: target.targetDir, outcome: "warning" as const, reason: `bundled ${target.skillName} skill source directory not found` };
    try {
      if (existsSync(target.targetDir)) {
        return {
          client: target.client,
          targetDir: target.targetDir,
          outcome: "skipped",
          reason: "existing install preserved",
        };
      }

      mkdirSync(dirname(target.targetDir), { recursive: true });
      cpSync(source, target.targetDir, { recursive: true });

      return {
        client: target.client,
        targetDir: target.targetDir,
        outcome: "installed",
      };
    } catch (error) {
      return {
        client: target.client,
        targetDir: target.targetDir,
        outcome: "warning",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return { sourceDir, results };
}

/** Backward-compatible name; it now installs every declared shipped skill. */
export function installBundledFusionSkill(options: {
  homeDir?: string;
  sourceDir?: string | null;
} = {}): InstallBundledFusionSkillResult {
  return installBundledShippedSkills(options);
}
