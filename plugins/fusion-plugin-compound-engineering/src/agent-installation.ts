import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
 * Mirrors `skill-installation.ts`: cpSync + skip-if-exists, plugin-local only,
 * never a global `<home>/.claude/agents` path.
 */

export type CeAgentInstallOutcome = "installed" | "skipped" | "error";

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

/**
 * Copy each bundled `ce-*.md` agent def into the plugin-local install target.
 * Idempotent: an existing target file is preserved (skip-if-exists).
 */
export function installBundledCeAgents(
  options: InstallBundledCeAgentsOptions = {},
): InstallBundledCeAgentsResult {
  const targetRoot = options.targetRoot
    ? resolve(options.targetRoot)
    : resolveDefaultAgentsInstallTargetRoot();
  assertPluginLocalAgentsTarget(targetRoot);

  const sourceRoot = options.sourceRoot ? resolve(options.sourceRoot) : resolveBundledAgentsRoot();

  const sourceFiles = existsSync(sourceRoot)
    ? readdirSync(sourceRoot).filter((f) => f.endsWith(".md"))
    : [];

  const results = sourceFiles.map<CeAgentInstallResult>((file) => {
    const agentId = file.replace(/\.md$/, "");
    const sourceFile = join(sourceRoot, file);
    const targetFile = join(targetRoot, file);
    try {
      assertValidAgentSource(agentId, sourceFile);

      if (existsSync(targetFile)) {
        return { agentId, sourceFile, targetFile, outcome: "skipped", reason: "existing install preserved" };
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

  return { targetRoot, results };
}

/** True if the given path is absolute and not inside a global client agents dir. */
export function isPluginLocalAgentsPath(p: string): boolean {
  return isAbsolute(p) && !GLOBAL_AGENT_DIR_PATTERN.test(resolve(p) + sep);
}
