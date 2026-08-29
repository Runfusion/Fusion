import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOUND_ENGINEERING_SKILLS } from "./skills.js";
import { CE_UPSTREAM_PROVENANCE } from "./upstream-provenance.js";

/**
 * Physical install of the bundled Compound Engineering skills.
 *
 * EMPIRICAL FINDING (U2): the engine never ingests
 * `PluginSkillContribution.skillFiles` into the set of skills that
 * pi-coding-agent's `DefaultResourceLoader`/`loadSkills` discovers. The
 * contribution only contributes a *name* to `requestedSkillNames`, which the
 * skill-resolver then tries to MATCH against skills already discovered from
 * disk. If no `SKILL.md` for that name was discovered, the requested name
 * resolves to nothing. Therefore a physical install into a discoverable,
 * PLUGIN-LOCAL skills directory is required.
 *
 * This mirrors the cpSync install posture of `installBundledFusionSkill`
 * (packages/cli) but the target is ALWAYS plugin-local — it MUST NOT be a
 * global `<home>/.claude/skills` path (R12/AE2). Existing plugin-local installs
 * are preserved only when their provenance marker matches the current bundled
 * upstream release; stale or unmarked installs are refreshed so users actually
 * receive vendored prompt updates.
 * The installed directory is intended to be wired into a session via
 * `additionalSkillPaths` (engine-side, in later units), keeping discovery
 * scoped to the plugin and never clobbering a user's global install.
 */

export type CeSkillInstallOutcome = "installed" | "refreshed" | "skipped" | "error";

export interface CeSkillInstallResult {
  skillId: string;
  sourceDir: string;
  targetDir: string;
  outcome: CeSkillInstallOutcome;
  reason?: string;
}

export interface InstallBundledCeSkillsResult {
  targetRoot: string;
  results: CeSkillInstallResult[];
}

/**
 * Absolute path to the plugin's bundled `src/skills` directory (the pinned
 * source of truth). Resolved relative to this module so it is correct whether
 * running from `src` (tests/dev) or `dist` (build output).
 */
export function resolveBundledSkillsRoot(): string {
  const here = fileURLToPath(import.meta.url);
  // src/skill-installation.ts -> src/skills ; dist/skill-installation.js -> the
  // bundled skills live next to source under src/skills, so when running from
  // dist we walk up one and into src/skills.
  const dir = dirname(here);
  const local = resolve(dir, "skills");
  if (existsSync(local)) return local;
  return resolve(dir, "..", "src", "skills");
}

/**
 * Default plugin-local install target. Lives under the plugin package root
 * (`.fusion-ce-skills/`), which is ALWAYS plugin-local and never a global
 * client skills directory. Callers may override via `targetRoot` (e.g. tests),
 * but a guard rejects any target inside a global ".claude"/".codex"/".gemini"
 * skills tree.
 */
export function resolveDefaultInstallTargetRoot(): string {
  const here = fileURLToPath(import.meta.url);
  // <pkg>/(src|dist)/skill-installation.* -> <pkg>/.fusion-ce-skills
  return resolve(dirname(here), "..", ".fusion-ce-skills");
}

const GLOBAL_SKILL_DIR_PATTERN = /[\\/]\.(claude|codex|gemini)[\\/]skills([\\/]|$)/;

/**
 * Guard: refuse to install into a global client skills directory.
 * This is the AE2 isolation invariant — the global compound-engineering install
 * (if present) must be provably untouched.
 */
export function assertPluginLocalTarget(targetRoot: string): void {
  const normalized = resolve(targetRoot);
  if (GLOBAL_SKILL_DIR_PATTERN.test(normalized + sep)) {
    throw new Error(
      `Refusing to install Compound Engineering skills into a global client skills directory: ${normalized}. ` +
        `Install target MUST be plugin-local (never <home>/.claude|.codex|.gemini/skills).`,
    );
  }
}

/**
 * Validate that a bundled SKILL.md exists and has a non-empty frontmatter
 * `name:`. A malformed/missing file surfaces a clear error instead of being
 * silently skipped.
 */
function assertValidSkillSource(skillId: string, sourceDir: string): void {
  if (!existsSync(sourceDir)) {
    throw new Error(`Bundled skill source directory missing for '${skillId}': ${sourceDir}`);
  }
  const skillMd = join(sourceDir, "SKILL.md");
  if (!existsSync(skillMd)) {
    throw new Error(`Bundled skill '${skillId}' has no SKILL.md at ${skillMd}`);
  }
  const content = readFileSync(skillMd, "utf-8");
  if (!/^---[\s\S]*?\bname\s*:\s*\S/m.test(content)) {
    throw new Error(
      `Bundled skill '${skillId}' SKILL.md at ${skillMd} is missing a frontmatter 'name:' field`,
    );
  }
}

export interface InstallBundledCeSkillsOptions {
  /** Override the install target root (must be plugin-local). */
  targetRoot?: string;
  /** Override the bundled source root (tests). */
  sourceRoot?: string;
}

const SKILL_INSTALL_PROVENANCE_FILE = ".fusion-ce-upstream-provenance.json";

function installProvenancePath(targetRoot: string): string {
  return join(targetRoot, SKILL_INSTALL_PROVENANCE_FILE);
}

function isCurrentInstalledProvenance(targetRoot: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(installProvenancePath(targetRoot), "utf-8")) as Partial<
      typeof CE_UPSTREAM_PROVENANCE
    >;
    return (
      marker.releaseTag === CE_UPSTREAM_PROVENANCE.releaseTag &&
      marker.tarballSha256 === CE_UPSTREAM_PROVENANCE.tarballSha256
    );
  } catch {
    return false;
  }
}

function writeInstalledProvenance(targetRoot: string): void {
  mkdirSync(targetRoot, { recursive: true });
  writeFileSync(
    installProvenancePath(targetRoot),
    `${JSON.stringify(
      {
        repo: CE_UPSTREAM_PROVENANCE.repo,
        releaseTag: CE_UPSTREAM_PROVENANCE.releaseTag,
        commit: CE_UPSTREAM_PROVENANCE.commit,
        tarballSha256: CE_UPSTREAM_PROVENANCE.tarballSha256,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Copy each bundled CE skill directory into the plugin-local install target.
 *
 * FNXC:CompoundEngineering 2026-06-26-23:55:
 * Upstream v3.15.0 refreshes must reach existing enabled plugins, not only fresh installs. Refresh stale or unmarked plugin-local copies using a provenance marker while keeping current-version installs idempotent and never touching global client skill dirs.
 */
export function installBundledCeSkills(
  options: InstallBundledCeSkillsOptions = {},
): InstallBundledCeSkillsResult {
  const targetRoot = options.targetRoot
    ? resolve(options.targetRoot)
    : resolveDefaultInstallTargetRoot();
  assertPluginLocalTarget(targetRoot);

  const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : resolveBundledSkillsRoot();
  const installIsCurrent = isCurrentInstalledProvenance(targetRoot);

  const results = COMPOUND_ENGINEERING_SKILLS.map<CeSkillInstallResult>((skill) => {
    const sourceDir = join(sourceRoot, skill.skillId);
    const targetDir = join(targetRoot, skill.skillId);
    try {
      assertValidSkillSource(skill.skillId, sourceDir);

      if (existsSync(targetDir)) {
        if (installIsCurrent) {
          return { skillId: skill.skillId, sourceDir, targetDir, outcome: "skipped", reason: "current install preserved" };
        }
        rmSync(targetDir, { recursive: true, force: true });
        mkdirSync(targetRoot, { recursive: true });
        cpSync(sourceDir, targetDir, { recursive: true });
        return { skillId: skill.skillId, sourceDir, targetDir, outcome: "refreshed", reason: "stale install refreshed" };
      }

      mkdirSync(targetRoot, { recursive: true });
      cpSync(sourceDir, targetDir, { recursive: true });
      return { skillId: skill.skillId, sourceDir, targetDir, outcome: "installed" };
    } catch (error) {
      return {
        skillId: skill.skillId,
        sourceDir,
        targetDir,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  if (results.every((result) => result.outcome !== "error")) {
    writeInstalledProvenance(targetRoot);
  }

  return { targetRoot, results };
}

/** True if the given path is absolute and not inside a global client skills dir. */
export function isPluginLocalPath(p: string): boolean {
  return isAbsolute(p) && !GLOBAL_SKILL_DIR_PATTERN.test(resolve(p) + sep);
}
