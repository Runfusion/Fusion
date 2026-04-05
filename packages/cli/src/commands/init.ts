/**
 * Init command for kb CLI.
 *
 * Initializes a new kb project in the current directory by:
 * 1. Creating the .fusion/ directory with fusion.db
 * 2. Registering the project in the central database
 *
 * Idempotent: if already initialized, reports success without recreating.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { CentralCore } from "@fusion/core";
import { resolveGlobalDir } from "@fusion/core";

/** Options for the init command */
export interface InitOptions {
  /** Override the auto-detected project name */
  name?: string;
  /** Path to initialize (defaults to cwd) */
  path?: string;
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

  // Check if already initialized
  if (existsSync(fusionDir) && existsSync(dbPath)) {
    // Check if registered in central DB
    const central = new CentralCore();
    await central.init();

    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      console.log(`✓ kb project already initialized: "${existing.name}"`);
      console.log(`  Path: ${cwd}`);
      console.log(`\n  Project is registered in the central registry.`);
      console.log(`  To re-initialize with a different name, run:`);
      console.log(`    fn project remove ${existing.name}`);
      console.log(`    fn init --name <new-name>`);
      await central.close();
      return;
    }

    // Has .fusion/ but not registered - offer to register
    const projectName = options.name ?? detectProjectName(cwd);
    console.log(`⚠ Project directory exists but not registered.`);
    console.log(`  Run: fn project add ${projectName} ${cwd}`);
    console.log(`  Or: rm -rf ${fusionDir} && fn init`);
    await central.close();
    return;
  }

  // Get or generate project name
  const projectName = options.name ?? detectProjectName(cwd);

  console.log(`Initializing kb project: "${projectName}"`);
  console.log(`  Path: ${cwd}`);

  // Create .fusion/ directory
  if (!existsSync(fusionDir)) {
    mkdirSync(fusionDir, { recursive: true });
    console.log(`  ✓ Created .fusion/ directory`);
  }

  // Create fusion.db (empty SQLite file)
  if (!existsSync(dbPath)) {
    // SQLite database header for an empty database
    const sqliteHeader = Buffer.from([
      0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66,
      0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00
    ]);
    writeFileSync(dbPath, sqliteHeader);
    console.log(`  ✓ Created fusion.db`);
  }

  // Register in central database
  const central = new CentralCore();
  await central.init();

  try {
    // Check if already registered
    const existing = await central.getProjectByPath(cwd);
    if (existing) {
      console.log(`  ✓ Already registered in central database`);
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
function detectProjectName(dir: string): string {
  // Try git remote first
  try {
    const remoteUrl = execSync("git remote get-url origin 2>/dev/null", {
      cwd: dir,
      encoding: "utf-8",
    }).trim();

    if (remoteUrl) {
      // Extract repo name from URL
      // Handles: https://github.com/user/repo.git, git@github.com:user/repo.git
      const match = remoteUrl.match(/[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
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
