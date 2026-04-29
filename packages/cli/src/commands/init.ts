/**
 * Init command for fn CLI.
 *
 * Initializes a new fn project in the current directory by:
 * 1. Creating the .fusion/ directory with fusion.db
 * 2. Registering the project in the central database
 *
 * Idempotent: if already initialized, reports success without recreating.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);
import { CentralCore, QMD_INSTALL_COMMAND, isQmdAvailable, isValidSqliteDatabaseFile } from "@fusion/core";
import { maybeInstallClaudeSkillForNewProject } from "./claude-skills-runner.js";
import { isGitRepo } from "./git.js";
import {
  installBundledFusionSkill,
  type SkillInstallResult,
} from "./skill-installation.js";

/** Options for the init command */
export interface InitOptions {
  /** Override the auto-detected project name */
  name?: string;
  /** Path to initialize (defaults to cwd) */
  path?: string;
  /** Initialize a git repository if one does not exist */
  git?: boolean;
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

  // Check if already initialized
  if (existsSync(fusionDir) && hasDbPath && hasValidDb) {
    // Check if registered in central DB
    const central = new CentralCore();
    await central.init();

    const existing = await central.getProjectByPath(cwd);
    if (existing) {
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

  if (existsSync(fusionDir) && hasDbPath && !hasValidDb) {
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

  const hasGitRepo = await isGitRepo(cwd);
  if (!hasGitRepo && options.git) {
    await initializeGitRepo(cwd);
    console.log(`  ✓ Initialized git repository`);
  } else if (!hasGitRepo) {
    console.log(`  ⚠ Not a git repository. Run 'fn init --git' to auto-initialize one.`);
  }

  // Add local Fusion/Pi storage directories to .gitignore
  await addLocalStorageToGitignore(cwd);
  await warnIfQmdMissing();

  // Create fusion.db (empty SQLite file)
  if (!existsSync(dbPath)) {
    // A zero-byte bootstrap file is a valid SQLite starting point.
    writeFileSync(dbPath, "");
    console.log(`  ✓ Created fusion.db`);
  }

  const bundledSkillInstall = installBundledFusionSkill();
  logBundledSkillInstallResults(bundledSkillInstall.results);

  // Register in central database
  const central = new CentralCore();
  await central.init();

  try {
    // Check if already registered
    const existing = await central.getProjectByPath(cwd);
    if (existing) {
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

    // Register new project
    const project = await central.registerProject({
      name: projectName,
      path: cwd,
      isolationMode: "in-process",
    });

    // Activate the project (registration sets it to 'initializing')
    await central.updateProject(project.id, { status: "active" });

    maybeInstallClaudeSkillForNewProject(cwd);

    console.log(`  ✓ Registered in central database`);
    console.log(`\n✓ Project "${project.name}" initialized successfully!`);
    console.log(`\n  Next steps:`);
    console.log(`    fn task list       # View tasks`);
    console.log(`    fn task create    # Create a task`);
    console.log(`    fn dashboard      # Open the web UI`);

    await central.close();
  } catch (err) {
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

/**
 * Add local Fusion/Pi storage directories to .gitignore if not already present.
 * Idempotent: only adds missing entries.
 */
async function addLocalStorageToGitignore(cwd: string): Promise<void> {
  const gitignorePath = join(cwd, ".gitignore");

  let content = "";
  if (existsSync(gitignorePath)) {
    try {
      content = readFileSync(gitignorePath, "utf-8");
    } catch {
      // Best-effort: if we can't read, treat as empty
    }
  }

  const lines = content.split(/\r?\n/);
  const existingEntries = new Set(lines.map((line) => line.trim()));
  const missingEntries = [".fusion", ".pi"].filter((entry) => !existingEntries.has(entry));

  if (missingEntries.length === 0) {
    return;
  }

  const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  const newContent = `${content}${prefix}${missingEntries.join("\n")}\n`;
  try {
    writeFileSync(gitignorePath, newContent);
    console.log(`  ✓ Added ${missingEntries.join(" and ")} to .gitignore`);
  } catch {
    // Best-effort: don't fail init if we can't write to .gitignore
    console.log(`  ⚠ Could not update .gitignore (best-effort)`);
  }
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await execAsync("git init", { cwd, timeout: 10_000 });

  try {
    const { stdout } = await execAsync("git symbolic-ref --quiet --short HEAD", {
      cwd,
      timeout: 10_000,
    });
    if (stdout.trim() !== "main") {
      await execAsync("git checkout -b main", { cwd, timeout: 10_000 });
    }
  } catch {
    // Older git versions or detached/unborn states may fail symbolic-ref.
    // Best-effort: create/switch to main.
    try {
      await execAsync("git checkout -b main", { cwd, timeout: 10_000 });
    } catch {
      await execAsync("git checkout main", { cwd, timeout: 10_000 });
    }
  }

  await ensureGitConfig(cwd, "user.name", "Fusion");
  await ensureGitConfig(cwd, "user.email", "noreply@runfusion.ai");

  const gitkeepPath = join(cwd, ".gitkeep");
  if (!existsSync(gitkeepPath)) {
    writeFileSync(gitkeepPath, "\n");
  }

  await execAsync("git add .gitkeep", { cwd, timeout: 10_000 });
  await execAsync('git commit --allow-empty -m "chore: initial commit"', {
    cwd,
    timeout: 10_000,
  });
}

async function ensureGitConfig(cwd: string, key: string, value: string): Promise<void> {
  try {
    const { stdout } = await execAsync(`git config --get ${key}`, { cwd, timeout: 10_000 });
    if (stdout.trim().length > 0) {
      return;
    }
  } catch {
    // Missing config; set a local default.
  }

  await execAsync(`git config ${key} "${value}"`, { cwd, timeout: 10_000 });
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
