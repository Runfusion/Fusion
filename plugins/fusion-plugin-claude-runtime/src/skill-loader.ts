/*
FNXC:ClaudeAcp 2026-07-11-14:00:
Stage Fusion + session skills so Claude ACP discovers them the same way pi does.
Claude loads skills from trusted `--plugin-dir` / `_meta.pluginDirs` plugins
(skills/ SKILL.md tree). We materialize a session-scoped plugin directory with:
  - the bundled Fusion skill (fn_* tool catalog + workflows)
  - skills from engine additionalSkillPaths / skill roots
Requested skill names are also listed in runtime context rules so the agent
still sees the selection when a skill file cannot be resolved on disk.

FNXC:ClaudeAcp 2026-07-12-06:15:
Packaged `@runfusion/fusion` publishes `skill/**` (not only monorepo
`packages/cli/skill/fusion`). Expand fusion-skill candidates so CLI installs under
`dist/plugins/fusion-plugin-claude-runtime/` still resolve `skill/fusion` at the
package root, via parent walks, createRequire of `@runfusion/fusion/package.json`,
and optional `FUSION_SKILL_SOURCE`. Missing fusion skill must not fail session
create — rules still list requested skills via buildClaudeSkillRules.
*/

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FUSION_SKILL_NAME = "fusion";
export const COMPUTER_USE_SKILL_NAME = "computer-use";

export interface ClaudeSkillStagingResult {
  pluginDir: string;
  skillNames: string[];
  dispose: () => void;
}

function isSkillDir(dir: string): boolean {
  return existsSync(join(dir, "SKILL.md"));
}

function pushUnique(out: string[], candidate: string | null | undefined): void {
  if (!candidate) return;
  const resolved = resolve(candidate);
  if (!out.includes(resolved)) out.push(resolved);
}

function pushSkillLayoutsAtRoot(out: string[], root: string, skillName: string): void {
  pushUnique(out, join(root, "skill", skillName));
  pushUnique(out, join(root, "packages", "cli", "skill", skillName));
}

function walkAncestorSkillCandidates(out: string[], startDir: string, skillName: string, maxParents = 8): void {
  let dir = startDir;
  for (let i = 0; i < maxParents; i++) {
    pushSkillLayoutsAtRoot(out, dir, skillName);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

function pushPackageRequireCandidates(out: string[], from: string, skillName: string): void {
  try {
    const require = createRequire(from);
    const pkgJson = require.resolve("@runfusion/fusion/package.json");
    pushUnique(out, join(dirname(pkgJson), "skill", skillName));
  } catch {
    // Package not resolvable from this origin (plugin-only tree, tests, etc.).
  }
}

/** Ordered candidate directories for a bundled skill. First existing directory wins. */
function getSkillSourceCandidates(skillName: string, moduleUrl = import.meta.url): string[] {
  const candidates: string[] = [];
  const here = fileURLToPath(moduleUrl);
  const moduleDir = dirname(here);

  pushUnique(candidates, resolve(moduleDir, "..", "..", "..", "packages", "cli", "skill", skillName));
  pushUnique(candidates, resolve(moduleDir, "..", "..", "skill", skillName));
  pushUnique(candidates, resolve(moduleDir, "..", "skill", skillName));
  pushUnique(candidates, resolve(moduleDir, "..", "..", "..", "skill", skillName));
  pushUnique(candidates, resolve(moduleDir, "../../../skill", skillName));

  walkAncestorSkillCandidates(candidates, moduleDir, skillName, 8);
  pushPackageRequireCandidates(candidates, moduleUrl, skillName);

  const argv1 = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  if (argv1) {
    try {
      const argvPath = resolve(argv1);
      pushPackageRequireCandidates(candidates, argvPath, skillName);
      walkAncestorSkillCandidates(candidates, dirname(argvPath), skillName, 8);
    } catch {
      // ignore bad argv paths
    }
  }
  return candidates;
}

/** Candidate ordering and FUSION_SKILL_SOURCE precedence remain fusion-only. */
export function getFusionSkillSourceCandidates(moduleUrl = import.meta.url): string[] {
  const candidates: string[] = [];
  const envSource = process.env.FUSION_SKILL_SOURCE?.trim();
  if (envSource) pushUnique(candidates, envSource);
  for (const candidate of getSkillSourceCandidates(FUSION_SKILL_NAME, moduleUrl)) pushUnique(candidates, candidate);
  return candidates;
}

export function getComputerUseSkillSourceCandidates(moduleUrl = import.meta.url): string[] {
  return getSkillSourceCandidates(COMPUTER_USE_SKILL_NAME, moduleUrl);
}

function resolveSkillSource(candidates: string[]): string | null {
  for (const candidate of candidates) if (isSkillDir(candidate)) return candidate;
  return null;
}

export function resolveBundledFusionSkillSource(moduleUrl = import.meta.url): string | null {
  return resolveSkillSource(getFusionSkillSourceCandidates(moduleUrl));
}

export function shouldStageComputerUseSkill(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

export function resolveBundledComputerUseSkillSource(
  moduleUrl = import.meta.url,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!shouldStageComputerUseSkill(platform)) return null;
  return resolveSkillSource(getComputerUseSkillSourceCandidates(moduleUrl));
}

function resolvedRealPath(path: string | null): string | null {
  if (!path) return null;
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function installSkillDir(sourceDir: string, targetDir: string): boolean {
  if (!isSkillDir(sourceDir)) return false;
  mkdirSync(dirname(targetDir), { recursive: true });
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  try {
    symlinkSync(sourceDir, targetDir, "dir");
    return true;
  } catch {
    try {
      cpSync(sourceDir, targetDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
}

function collectSkillsFromRoot(root: string, out: Map<string, string>): void {
  if (!existsSync(root)) return;
  // Root may itself be a skill (…/skills/foo with SKILL.md) or a skills container.
  if (isSkillDir(root)) {
    out.set(basename(root), root);
    return;
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const child = join(root, entry);
    if (isSkillDir(child)) {
      out.set(entry, child);
    }
  }
}

export interface StageClaudeSkillsOptions {
  /** Engine-requested skill names (skillSelection / skills). */
  requestedSkillNames?: string[];
  /** Extra skill roots (plugin skill dirs, CE install roots, etc.). */
  additionalSkillPaths?: string[];
  /** Always include the bundled Fusion skill (default true). */
  includeFusionSkill?: boolean;
  /** Platform injection keeps both platform branches testable on every host. */
  platform?: NodeJS.Platform;
  /** Suppression-only: it can disable computer-use, never override its Darwin gate. */
  includeComputerUseSkill?: boolean;
  /** Module URL override for packaged-layout resolution tests. */
  moduleUrl?: string;
}

/**
 * Build a session-scoped Claude plugin directory with Fusion + requested skills.
 */
export function stageClaudeSessionSkills(options: StageClaudeSkillsOptions = {}): ClaudeSkillStagingResult {
  const pluginDir = mkdtempSync(join(tmpdir(), "fusion-claude-plugin-"));
  const skillsDir = join(pluginDir, "skills");
  mkdirSync(skillsDir, { recursive: true });

  const installed = new Map<string, string>();
  const platform = options.platform ?? process.platform;
  const includeFusion = options.includeFusionSkill !== false;
  const moduleUrl = options.moduleUrl ?? import.meta.url;
  // FNXC:ClaudeAcp 2026-08-11-09:23: FN-8984 requires computer-use only on Darwin.
  // Gate both source resolution and installation so no requested/additional option can force
  // the FN-8961 discovery stub (and never its command flags/body) onto another platform.
  const includeComputerUse = options.includeComputerUseSkill !== false && shouldStageComputerUseSkill(platform);
  const bundledComputerUseSource = resolveBundledComputerUseSkillSource(moduleUrl, "darwin");
  const bundledComputerUseRealPath = resolvedRealPath(bundledComputerUseSource);
  const installedBundledNames = new Set<string>();

  if (includeFusion) {
    const fusionSource = resolveBundledFusionSkillSource(moduleUrl);
    if (fusionSource && installSkillDir(fusionSource, join(skillsDir, FUSION_SKILL_NAME))) {
      installed.set(FUSION_SKILL_NAME, fusionSource);
      installedBundledNames.add(FUSION_SKILL_NAME);
    }
  }
  if (includeComputerUse) {
    const computerUseSource = resolveBundledComputerUseSkillSource(moduleUrl, platform);
    if (computerUseSource && installSkillDir(computerUseSource, join(skillsDir, COMPUTER_USE_SKILL_NAME))) {
      installed.set(COMPUTER_USE_SKILL_NAME, computerUseSource);
      installedBundledNames.add(COMPUTER_USE_SKILL_NAME);
    }
  }

  for (const root of options.additionalSkillPaths ?? []) {
    if (typeof root !== "string" || !root.trim()) continue;
    const collected = new Map<string, string>();
    collectSkillsFromRoot(root.trim(), collected);
    for (const [name, source] of collected) {
      if (!shouldStageComputerUseSkill(platform) && bundledComputerUseRealPath && resolvedRealPath(source) === bundledComputerUseRealPath) continue;
      installed.set(name, source);
    }
  }

  // FNXC:ClaudeAcp 2026-08-11-09:41: Preserve Fusion's existing bundled precedence, but let a
  // user-owned computer-use root override the Darwin bundle without reinstalling the same source.
  for (const [name, source] of installed) {
    if (name === FUSION_SKILL_NAME && includeFusion) continue;
    if (name === COMPUTER_USE_SKILL_NAME && installedBundledNames.has(name) && source === bundledComputerUseSource) continue;
    installSkillDir(source, join(skillsDir, name));
  }

  for (const [name, source] of installed) {
    if (!existsSync(join(skillsDir, name))) installSkillDir(source, join(skillsDir, name));
  }

  writeFileSync(
    join(pluginDir, "plugin.json"),
    JSON.stringify(
      {
        name: "fusion-session-skills",
        version: "0.1.0",
        description: "Session-scoped Fusion skills for Claude ACP",
      },
      null,
      2,
    ),
  );

  const skillNames = Array.from(
    new Set([
      ...installed.keys(),
      ...(options.requestedSkillNames ?? []).filter(
        (n) => typeof n === "string" && n.trim().length > 0 &&
          (n !== COMPUTER_USE_SKILL_NAME || shouldStageComputerUseSkill(platform) || installed.has(n)),
      ),
    ]),
  );

  return {
    pluginDir,
    skillNames,
    dispose: () => {
      try {
        rmSync(pluginDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

/**
 * Build a short rules block listing requested skills and reminding Claude to use
 * Fusion tools/MCP when available.
 */
export function buildClaudeSkillRules(options: {
  skillNames: string[];
  toolMode?: string;
  fusionToolCount?: number;
  operatorMcpCount?: number;
}): string {
  const lines = [
    "Fusion runtime context for this session:",
    `- Tool mode: ${options.toolMode ?? "coding"}`,
  ];
  if (options.skillNames.length > 0) {
    lines.push(`- Loaded / requested skills: ${options.skillNames.join(", ")}`);
  }
  if (typeof options.fusionToolCount === "number") {
    lines.push(`- Fusion custom tools (fn_*) available via MCP server "fusion-custom-tools": ${options.fusionToolCount}`);
  }
  if (typeof options.operatorMcpCount === "number" && options.operatorMcpCount > 0) {
    lines.push(`- Operator MCP servers forwarded into this session: ${options.operatorMcpCount}`);
  }
  lines.push(
    "- Prefer Fusion fn_* MCP tools for task board / coordination actions (e.g. fn_task_done, fn_task_list) when they are available.",
    "- Use the Fusion skill workflows when planning or managing tasks.",
  );
  return lines.join("\n");
}

export function extractRequestedSkillNames(options: {
  skills?: unknown;
  skillSelection?: unknown;
}): string[] {
  const fromSkills = Array.isArray(options.skills)
    ? options.skills.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const selection = options.skillSelection as { requestedSkillNames?: unknown } | undefined;
  const fromSelection = Array.isArray(selection?.requestedSkillNames)
    ? selection.requestedSkillNames.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  return Array.from(new Set(fromSkills.length > 0 ? fromSkills : fromSelection));
}
