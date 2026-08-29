/**
 * Init command for fn CLI.
 *
 * Initializes a new fn project in the current directory by:
 * 1. Creating the .fusion/ directory and PostgreSQL-neutral project identity
 * 2. Registering the project in the central database
 *
 * Idempotent: if already initialized, reports success without recreating.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import {
  CentralCore,
  GitRepositoryInitializationError,
  QMD_INSTALL_COMMAND,
  isQmdAvailable,
  hasProjectIdentity,
  isValidSqliteDatabaseFile,
  readProjectIdentity,
  writeProjectIdentity,
} from "@fusion/core";
import { maybeInstallClaudeSkillForNewProject } from "./claude-skills-runner.js";
import {
  installBundledShippedSkills,
  type SkillInstallResult,
} from "./skill-installation.js";

/** Options for the init command */
export interface InitOptions {
  /** Override the auto-detected project name */
  name?: string;
  /** Path to initialize (defaults to cwd) */
  path?: string;
  /** Compatibility flag; project readiness is now always established. */
  git?: boolean;
}

/*
FNXC:IntegrationBranchReadiness 2026-08-24-00:57:
FN-183 makes registration reconcile a local integration ref. Show the one-repository result in
CLI output, including an unavailable materialization, so operators can see whether Fusion adopted
or created the branch without pretending workspace-member results describe the project root.
*/
function logIntegrationBranchReconciliation(integrationBranches: unknown, indentation = "  "): void {
  if (!Array.isArray(integrationBranches) || integrationBranches.length !== 1) return;
  const [entry] = integrationBranches as Array<{ repoRelPath?: unknown; branch?: unknown; action?: unknown }>;
  if (
    entry?.repoRelPath !== "."
    || typeof entry.branch !== "string"
    || entry.branch.trim().length === 0
    || typeof entry.action !== "string"
    || entry.action.trim().length === 0
  ) return;
  console.log(`${indentation}✓ Integration branch: ${entry.branch} (${entry.action})`);
}

/**
 * Run the init command.
 *
 * @param options - Optional configuration for init
 * @returns Promise that resolves when initialization is complete
 */
export async function runInit(options: InitOptions = {}): Promise<void> {
  const cwd = options.path ? resolve(options.path) : process.cwd();
  const fusionDir = join(cwd, ".fusion");
  const dbPath = join(fusionDir, "fusion.db");
  const hasDbPath = existsSync(dbPath);
  const hasValidDb = hasDbPath && isValidSqliteDatabaseFile(dbPath);
  /*
  FNXC:ProjectIdentityMarker 2026-07-14-17:20:
  `fn init` treats `.fusion/project.json` as the durable local project marker. A valid fusion.db remains detectable only to migrate projects created before the PostgreSQL cutover; new initialization never creates a SQLite file.
  */
  const hasIdentity = hasProjectIdentity(fusionDir);

  // Check if already initialized
  if (existsSync(fusionDir) && (hasIdentity || hasValidDb)) {
    // Check if registered in central DB
    const central = new CentralCore();
    await central.init();

    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      // Repair Git readiness even when the project was already registered.
      const ensured = await central.ensureProjectForPath({
        path: cwd,
        identity: readProjectIdentity(fusionDir) ?? undefined,
        name: existing.name,
      });
      logIntegrationBranchReconciliation(ensured.integrationBranches);
      try {
        writeProjectIdentity(join(cwd, ".fusion"), {
          id: existing.id,
          createdAt: existing.createdAt,
        });
      } catch {
        // Best-effort backfill only.
      }
      console.log(`✓ fn project already initialized: "${existing.name}"`);
      console.log(`  Path: ${cwd}`);
      console.log(`\n  Project is registered in the central registry.`);
      console.log(`  To re-initialize with a different name, run:`);
      console.log(`    fn project remove ${existing.name}`);
      console.log(`    fn init --name <new-name>`);
      await central.close();
      return;
    }

    // Has .fusion/ but not registered - offer to register
    const projectName = options.name ?? await detectProjectName(cwd);
    console.log(`⚠ Project directory exists but not registered.`);
    console.log(`  Run: fn project add ${projectName} ${cwd}`);
    console.log(`  Or: rm -rf ${fusionDir} && fn init`);
    await central.close();
    return;
  }

  if (existsSync(fusionDir) && !hasIdentity && hasDbPath && !hasValidDb) {
    throw new Error(
      `Existing database at ${dbPath} is not a valid SQLite database. ` +
      "Restore it from .fusion/backups or move it aside before re-running fn init.",
    );
  }

  // Get or generate project name
  const projectName = options.name ?? await detectProjectName(cwd);

  console.log(`Initializing fn project: "${projectName}"`);
  console.log(`  Path: ${cwd}`);

  // Create .fusion/ directory
  if (!existsSync(fusionDir)) {
    mkdirSync(fusionDir, { recursive: true });
    console.log(`  ✓ Created .fusion/ directory`);
  }

  /*
  FNXC:ProjectSetup 2026-08-19-12:44:
  `--git` remains accepted for scripts that already pass it, but the shared CentralCore
  readiness seam now always creates the baseline and managed ignore rules. Keeping one
  path prevents default onboarding and explicit `--git` from producing different task state.
  */
  await warnIfQmdMissing();

  const bundledSkillInstall = installBundledShippedSkills();
  logBundledSkillInstallResults(bundledSkillInstall.results);

  // Register in central database
  const central = new CentralCore();
  await central.init();

  try {
    // Check if already registered
    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      // Repair Git readiness before reporting an already-registered project as ready.
      const ensured = await central.ensureProjectForPath({
        path: cwd,
        identity: readProjectIdentity(fusionDir) ?? undefined,
        name: existing.name,
      });
      logIntegrationBranchReconciliation(ensured.integrationBranches);
      /*
      FNXC:ProjectIdentityMarker 2026-07-14-22:25:
      A project already registered in PostgreSQL can still reach this branch when its local `.fusion/project.json` marker is missing. Repair the marker before returning so subsequent startup and init checks use the same durable identity as a newly registered project.
      */
      try {
        writeProjectIdentity(fusionDir, {
          id: existing.id,
          createdAt: existing.createdAt,
        });
      } catch (identityError) {
        console.warn(`  ⚠ Could not persist project identity: ${identityError instanceof Error ? identityError.message : String(identityError)}`);
      }
      console.log(`  ✓ Already registered in central database`);
      maybeInstallClaudeSkillForNewProject(cwd);
      console.log(`\n✓ Project "${projectName}" is ready!`);
      console.log(`\n  Next steps:`);
      console.log(`    fn task list       # View tasks`);
      console.log(`    fn task create    # Create a task`);
      console.log(`    fn dashboard      # Open the web UI`);
      await central.close();
      return;
    }

    const identity = readProjectIdentity(fusionDir);
    const ensured = await central.ensureProjectForPath({
      path: cwd,
      identity: identity ?? undefined,
      name: projectName,
    });

    const project = ensured.project;

    // Activate the project (registration sets it to 'initializing')
    await central.updateProject(project.id, { status: "active" });

    try {
      writeProjectIdentity(join(cwd, ".fusion"), {
        id: project.id,
        createdAt: project.createdAt,
      });
    } catch (identityError) {
      console.warn(`  ⚠ Could not persist project identity: ${identityError instanceof Error ? identityError.message : String(identityError)}`);
    }

    maybeInstallClaudeSkillForNewProject(cwd);

    if (ensured.gitRepository === "initialized") {
      console.log(`  ✓ Initialized git repository`);
    }
    logIntegrationBranchReconciliation(ensured.integrationBranches);
    console.log(`  ✓ Registered in central database`);
    console.log(`\n✓ Project "${project.name}" initialized successfully!`);
    console.log(`\n  Next steps:`);
    console.log(`    fn task list       # View tasks`);
    console.log(`    fn task create    # Create a task`);
    console.log(`    fn dashboard      # Open the web UI`);

    await central.close();
  } catch (err) {
    if (err instanceof GitRepositoryInitializationError) {
      await central.close();
      throw err;
    }
    // If central DB registration fails, still report success since local files are created
    console.log(`  ⚠ Could not register in central database: ${(err as Error).message}`);
    console.log(`\n✓ Project initialized locally (central registration can be done later)`);
    console.log(`\n  To register later, run:`);
    console.log(`    fn project add ${projectName} ${cwd}`);
    await central.close();
  }
}

/**
 * Detect a project name from git remote or directory name.
 */
async function detectProjectName(dir: string): Promise<string> {
  // Fast-path for non-git directories to avoid spawning git unnecessarily.
  // (This also prevents occasional command stalls in constrained CI envs.)
  if (!existsSync(join(dir, ".git"))) {
    return basename(dir) || "my-project";
  }

  // Try git remote first
  try {
    const { stdout: remoteUrl } = await execAsync("git remote get-url origin", {
      cwd: dir,
      timeout: 10_000,
    });

    const trimmed = remoteUrl.trim();
    if (trimmed) {
      // Extract repo name from URL
      // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
      const match = trimmed.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
      if (match) {
        return match[2];
      }
    }
  } catch {
    // Not a git repo or no origin remote
  }

  // Fallback to directory name
  return basename(dir) || "my-project";
}

async function warnIfQmdMissing(): Promise<void> {
  if (await isQmdAvailable()) {
    console.log(`  ✓ qmd available for memory search`);
    return;
  }

  console.log(`  ⚠ qmd not found; memory search will use local file fallback`);
  console.log(`    Install qmd for indexed retrieval: ${QMD_INSTALL_COMMAND}`);
}

function logBundledSkillInstallResults(results: SkillInstallResult[]): void {
  for (const result of results) {
    const clientLabel = result.client[0].toUpperCase() + result.client.slice(1);
    if (result.outcome === "installed") {
      console.log(`  ✓ Installed bundled Fusion skill for ${clientLabel}: ${result.targetDir}`);
      continue;
    }

    if (result.outcome === "skipped") {
      console.log(`  ✓ Existing ${clientLabel} Fusion skill preserved: ${result.targetDir}`);
      continue;
    }

    console.warn(
      `  ⚠ Could not install bundled Fusion skill for ${clientLabel}: ${result.reason ?? "unknown error"}`,
    );
  }
}
