import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FUSION_SKILL_NAME = "fusion";
export const COMPUTER_USE_SKILL_NAME = "computer-use";

export type HermesFusionSkillInstallOutcome =
  | "installed"
  | "already-installed"
  | "replaced"
  | "skipped"
  | "warning";

export interface HermesFusionSkillInstallResult {
  outcome: HermesFusionSkillInstallOutcome;
  sourceDir: string | null;
  targetDir: string;
  reason?: string;
}

export function resolveHermesHome(profile?: string): string {
  const base = process.env.HERMES_HOME ?? join(homedir(), ".hermes");
  if (!profile || profile === "default") return base;
  return join(base, "profiles", profile);
}

function getSkillSourceCandidates(skillName: string, moduleUrl = import.meta.url): string[] {
  const here = fileURLToPath(moduleUrl);
  const moduleDir = dirname(here);
  return [
    resolve(moduleDir, "..", "..", "..", "..", "packages", "cli", "skill", skillName),
    resolve(moduleDir, "..", "..", "..", "skill", skillName),
    resolve(moduleDir, "..", "..", "skill", skillName),
    resolve(moduleDir, "..", "..", "..", "..", "skill", skillName),
  ];
}

export function getFusionSkillSourceCandidates(moduleUrl = import.meta.url): string[] {
  return getSkillSourceCandidates(FUSION_SKILL_NAME, moduleUrl);
}

export function getComputerUseSkillSourceCandidates(moduleUrl = import.meta.url): string[] {
  return getSkillSourceCandidates(COMPUTER_USE_SKILL_NAME, moduleUrl);
}

function resolveBundledSkillSourceFromCandidates(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

export function resolveBundledFusionSkillSource(): string | null {
  return resolveBundledSkillSourceFromCandidates(getFusionSkillSourceCandidates());
}

export function resolveBundledComputerUseSkillSource(): string | null {
  return resolveBundledSkillSourceFromCandidates(getComputerUseSkillSourceCandidates());
}

export function resolveBundledFusionSkillSourceFromCandidates(candidates: string[]): string | null {
  return resolveBundledSkillSourceFromCandidates(candidates);
}

export function shouldInstallComputerUseSkill(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

interface InstallSkillOptions {
  profile?: string;
  sourceDir?: string | null;
}

function installSkillIntoHermesHome(
  skillName: string,
  options: InstallSkillOptions,
  resolveSource: () => string | null,
): HermesFusionSkillInstallResult {
  const sourceDir = options.sourceDir ?? resolveSource();
  const targetDir = join(resolveHermesHome(options.profile), "skills", skillName);
  if (!sourceDir) {
    return { outcome: "warning", sourceDir, targetDir, reason: `bundled ${skillName} skill source directory not found` };
  }

  try {
    mkdirSync(dirname(targetDir), { recursive: true });
    let replaced = false;
    if (existsSync(targetDir) || isBrokenSymlink(targetDir)) {
      const stat = lstatSync(targetDir);
      if (stat.isSymbolicLink()) {
        const currentTarget = safeReadlink(targetDir);
        if (currentTarget && resolve(dirname(targetDir), currentTarget) === resolve(sourceDir)) {
          return { outcome: "already-installed", sourceDir, targetDir };
        }
        if (!looksLikeFusionSkillTarget(resolve(dirname(targetDir), currentTarget ?? ""), skillName)) {
          return { outcome: "skipped", sourceDir, targetDir, reason: "existing symlink does not look like a Fusion skill install" };
        }
        unlinkSync(targetDir);
        replaced = true;
      } else {
        if (!looksLikePriorFusionInstall(targetDir, skillName)) {
          return { outcome: "skipped", sourceDir, targetDir, reason: "existing directory does not look like a Fusion skill install" };
        }
        rmSync(targetDir, { recursive: true, force: true });
        replaced = true;
      }
    }
    try {
      symlinkSync(sourceDir, targetDir, "dir");
    } catch (error) {
      const symlinkReason = error instanceof Error ? error.message : String(error);
      try {
        cpSync(sourceDir, targetDir, { recursive: true });
        return { outcome: replaced ? "replaced" : "installed", sourceDir, targetDir, reason: `symlink failed (${symlinkReason}); copied files instead` };
      } catch (copyError) {
        return { outcome: "warning", sourceDir, targetDir, reason: copyError instanceof Error ? copyError.message : String(copyError) };
      }
    }
    return { outcome: replaced ? "replaced" : "installed", sourceDir, targetDir };
  } catch (error) {
    return { outcome: "warning", sourceDir, targetDir, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function installFusionSkillIntoHermesHome(options: InstallSkillOptions = {}): HermesFusionSkillInstallResult {
  return installSkillIntoHermesHome(FUSION_SKILL_NAME, options, resolveBundledFusionSkillSource);
}

/*
FNXC:HermesRuntime 2026-08-11-09:23:
FN-8984 makes computer-use Darwin-only because the CLI capability is macOS-only. This persistent,
public installer self-defends before any filesystem access: callers cannot override its platform gate
and it must never clobber a user-owned ~/.hermes skill target.
*/
export function installComputerUseSkillIntoHermesHome(options: InstallSkillOptions & {
  platform?: NodeJS.Platform;
} = {}): HermesFusionSkillInstallResult {
  const platform = options.platform ?? process.platform;
  if (!shouldInstallComputerUseSkill(platform)) {
    return {
      outcome: "skipped",
      sourceDir: options.sourceDir ?? null,
      // Do not resolve Hermes home here: the gate must perform no filesystem reads.
      targetDir: "",
      reason: `computer-use installation is gated to darwin (current platform: ${platform})`,
    };
  }
  return installSkillIntoHermesHome(COMPUTER_USE_SKILL_NAME, options, resolveBundledComputerUseSkillSource);
}

function safeReadlink(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}

function isBrokenSymlink(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isSymbolicLink() && !existsSync(path); } catch { return false; }
}

function looksLikePriorFusionInstall(path: string, skillName: string): boolean {
  const skillMd = join(path, "SKILL.md");
  if (!existsSync(skillMd)) return false;
  try {
    const body = readFileSync(skillMd, "utf-8");
    return skillName === FUSION_SKILL_NAME
      ? /\bfusion\b/i.test(body) && /\bskill\b/i.test(body)
      : /computer[- ]use|fn computer/i.test(body);
  } catch { return false; }
}

function looksLikeFusionSkillTarget(path: string, skillName: string): boolean {
  if (!path) return false;
  return basename(path).toLowerCase() === skillName || existsSync(join(path, "SKILL.md"));
}
