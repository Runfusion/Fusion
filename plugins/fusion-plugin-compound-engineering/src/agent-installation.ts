import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CE_UPSTREAM_PROVENANCE } from "./upstream-provenance.js";

/**
 * Physical install of the bundled Compound Engineering agent persona
 * definitions (the `ce-*` reviewer/research personas the CE skills fan out to).
 *
 * WHY A PHYSICAL INSTALL + ENV, NOT A PLUGIN CONTRIBUTION (spike finding):
 * Fusion has no plugin agent-contribution channel — `FusionPlugin` contributes
 * skills/workflowSteps/traits but not agents, and `fn_spawn_agent` resolves no
 * persona by name. So the CE skills running inside a workflow step read a
 * persona def from disk and pass its body to `fn_spawn_agent` via the
 * `systemPromptOverride` param. For the skill to find the defs, they are
 * installed into a plugin-local directory whose path is exported to step
 * sessions through the plugin's `executorRuntimeEnv` hook (FUSION_CE_AGENTS_DIR).
 *
 * Mirrors `skill-installation.ts`: cpSync into a plugin-local directory, never a
 * global `<home>/.claude/agents` path. Existing plugin-local copies are refreshed
 * when their provenance marker is absent or stale so prompt persona updates reach
 * existing enabled plugins.
 */

export type CeAgentInstallOutcome = "installed" | "refreshed" | "skipped" | "error";

export interface CeAgentInstallResult {
  agentId: string;
  sourceFile: string;
  targetFile: string;
  outcome: CeAgentInstallOutcome;
  reason?: string;
}

export interface InstallBundledCeAgentsResult {
  targetRoot: string;
  results: CeAgentInstallResult[];
}

/** Absolute path to the plugin's bundled `src/agents` directory (source of truth). */
export function resolveBundledAgentsRoot(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const local = resolve(dir, "agents");
  if (existsSync(local)) return local;
  return resolve(dir, "..", "src", "agents");
}

/**
 * Default plugin-local install target (`.fusion-ce-agents/`). ALWAYS plugin-local
 * — never a global client agents directory.
 */
export function resolveDefaultAgentsInstallTargetRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", ".fusion-ce-agents");
}

const GLOBAL_AGENT_DIR_PATTERN = /[\\/]\.(claude|codex|gemini)[\\/]agents([\\/]|$)/;

/** Guard: refuse to install into a global client agents directory. */
export function assertPluginLocalAgentsTarget(targetRoot: string): void {
  const normalized = resolve(targetRoot);
  if (GLOBAL_AGENT_DIR_PATTERN.test(normalized + sep)) {
    throw new Error(
      `Refusing to install Compound Engineering agents into a global client agents directory: ${normalized}. ` +
        `Install target MUST be plugin-local (never <home>/.claude|.codex|.gemini/agents).`,
    );
  }
}

/** A bundled agent def must exist and carry a frontmatter `name:`. */
function assertValidAgentSource(agentId: string, sourceFile: string): void {
  if (!existsSync(sourceFile)) {
    throw new Error(`Bundled agent def missing for '${agentId}': ${sourceFile}`);
  }
  const content = readFileSync(sourceFile, "utf-8");
  if (!/^---[\s\S]*?\bname\s*:\s*\S/m.test(content)) {
    throw new Error(`Bundled agent def '${agentId}' at ${sourceFile} is missing a frontmatter 'name:' field`);
  }
}

export interface InstallBundledCeAgentsOptions {
  /** Override the install target root (must be plugin-local). */
  targetRoot?: string;
  /** Override the bundled source root (tests). */
  sourceRoot?: string;
}

const AGENT_INSTALL_PROVENANCE_FILE = ".fusion-ce-upstream-provenance.json";

function installProvenancePath(targetRoot: string): string {
  return join(targetRoot, AGENT_INSTALL_PROVENANCE_FILE);
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
 * Copy each bundled `ce-*.md` agent def into the plugin-local install target.
 *
 * FNXC:CompoundEngineering 2026-06-26-23:55:
 * Persona prompts are part of the pinned upstream bundle, so the plugin-local agent install uses the same provenance-aware refresh policy as skills. This prevents stale skip-if-exists installs from continuing to dispatch old personas after a vendored refresh.
 */
export function installBundledCeAgents(
  options: InstallBundledCeAgentsOptions = {},
): InstallBundledCeAgentsResult {
  const targetRoot = options.targetRoot
    ? resolve(options.targetRoot)
    : resolveDefaultAgentsInstallTargetRoot();
  assertPluginLocalAgentsTarget(targetRoot);

  const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : resolveBundledAgentsRoot();
  const installIsCurrent = isCurrentInstalledProvenance(targetRoot);

  let sourceFiles: string[];
  /*
  FNXC:CompoundEngineeringAgents 2026-07-19-09:50:
  A published package without bundled persona definitions is corrupt. Fail at plugin startup instead of silently installing zero agents and breaking later skill fanout.
  */
  try {
    sourceFiles = readdirSync(sourceRoot).filter((file) => file.endsWith(".md"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`Bundled agent persona source directory is missing: ${sourceRoot}`, { cause: error });
    }
    throw error;
  }
  if (sourceFiles.length === 0) {
    throw new Error(`Bundled agent persona source directory contains no markdown definitions: ${sourceRoot}`);
  }

  const results = sourceFiles.map<CeAgentInstallResult>((file) => {
    const agentId = file.replace(/\.md$/, "");
    const sourceFile = join(sourceRoot, file);
    const targetFile = join(targetRoot, file);
    try {
      assertValidAgentSource(agentId, sourceFile);

      if (existsSync(targetFile)) {
        if (installIsCurrent) {
          return { agentId, sourceFile, targetFile, outcome: "skipped", reason: "current install preserved" };
        }
        rmSync(targetFile, { force: true });
        mkdirSync(targetRoot, { recursive: true });
        cpSync(sourceFile, targetFile);
        return { agentId, sourceFile, targetFile, outcome: "refreshed", reason: "stale install refreshed" };
      }

      mkdirSync(targetRoot, { recursive: true });
      cpSync(sourceFile, targetFile);
      return { agentId, sourceFile, targetFile, outcome: "installed" };
    } catch (error) {
      return {
        agentId,
        sourceFile,
        targetFile,
        outcome: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });

  if (results.length > 0 && results.every((result) => result.outcome !== "error")) {
    writeInstalledProvenance(targetRoot);
  }

  return { targetRoot, results };
}

/** True if the given path is absolute and not inside a global client agents dir. */
export function isPluginLocalAgentsPath(p: string): boolean {
  return isAbsolute(p) && !GLOBAL_AGENT_DIR_PATTERN.test(resolve(p) + sep);
}
