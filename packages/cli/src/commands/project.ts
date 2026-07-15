/**
 * Project command implementations for fn CLI.
 *
 * Provides commands for managing the project registry:
 * - list: List all registered projects
 * - add: Register a new project
 * - remove: Unregister a project
 * - show: Show project details
 * - set-default: Set default project
 * - detect: Detect project from current directory
 */

import {
  CentralCore,
  GlobalSettingsStore,
  type TaskStore,
  createTaskStoreForBackend,
  hasProjectIdentity,
  isValidSqliteDatabaseFile,
  ensureMemoryFileWithBackend,
  type RegisteredProject,
  type IsolationMode,
  type ProjectHealth,
  COLUMNS,
  COLUMN_LABELS,
  type Column,
  countRunningAgentTasks,
  readProjectIdentity,
  writeProjectIdentity,
} from "@fusion/core";
import { resolve, isAbsolute, relative, basename, join } from "node:path";
import { existsSync, statSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { detectProjectFromCwd, setDefaultProject } from "../project-context.js";
import { maybeInstallClaudeSkillForNewProject } from "./claude-skills-runner.js";
import { retryOnLock } from "../lock-retry.js";

const VALID_ISOLATION_MODES: IsolationMode[] = ["in-process", "child-process"];

/**
 * Options for project list command.
 */
export interface ProjectListOptions {
  /** Output as JSON instead of table */
  json?: boolean;
}

/**
 * Options for project add command.
 */
export interface ProjectAddOptions {
  /** Isolation mode for the project */
  isolation?: IsolationMode;
  /** Skip confirmation prompts */
  force?: boolean;
  /** Interactive mode */
  interactive?: boolean;
}

/**
 * Options for project remove command.
 */
export interface ProjectRemoveOptions {
  /** Skip confirmation prompts */
  force?: boolean;
}

/**
 * Project info data structure for JSON output.
 */
export interface ProjectInfoData {
  id: string;
  name: string;
  path: string;
  status: string;
  isolationMode: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  health?: {
    activeTaskCount: number;
    inFlightAgentCount: number;
    totalTasksCompleted: number;
    totalTasksFailed: number;
  };
  taskCounts: Record<string, number>;
  defaultProject: boolean;
}

interface TaskCountSummary {
  byColumn: Record<string, number>;
  runningAgentCount: number;
}

/**
 * Format a path for display, showing relative path when possible.
 */
function formatDisplayPath(projectPath: string): string {
  const rel = relative(process.cwd(), projectPath);
  if (rel && !rel.startsWith("..") && rel !== "") {
    return rel;
  }
  return basename(projectPath) || ".";
}

/**
 * Format a timestamp for display (relative or absolute).
 */
function formatLastActivity(timestamp?: string | null): string {
  if (!timestamp) return "never";

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * FNXC:CliBoardMutation 2026-07-09-00:00:
 * FN-7740 audit finding: `getTaskCounts` builds an UNCACHED `new
 * TaskStore(projectPath)` per call and never closed it. `runProjectList`
 * calls this once per registered project in a `Promise.all` map, so an
 * N-project registry leaked N never-closed SQLite/WAL handles — each one
 * keeping the CLI event loop alive after `fn project list`'s real work was
 * done. Add an explicit `finally { store.close() }` so every call tears its
 * store down regardless of success/failure, keeping the existing outer
 * soft-catch (a genuinely unreadable project still reports empty counts
 * rather than failing the whole `list`/`show`). `listTasks` is additionally
 * wrapped in `retryOnLock` (FN-7731) so a momentary `database is locked`
 * from an active engine/agent writer does not silently masquerade as "zero
 * tasks" via the outer catch — it rides out the lock instead.
 */
async function getTaskCounts(projectPath: string): Promise<TaskCountSummary> {
  // FNXC:PostgresCutover 2026-07-04:
  // Route through createTaskStoreForBackend so the count works in PostgreSQL
  // backend mode. Previously this constructed `new TaskStore(projectPath)`,
  // which throws in backend mode (SQLite runtime removed under VAL-REMOVAL-005);
  // the surrounding try/catch swallowed it so project info/list silently showed
  // zero tasks. The boot result's shutdown() releases the connection pool (and
  // any embedded PostgreSQL process) so a one-shot CLI read leaks nothing.
  let store: TaskStore | undefined;
  let backendShutdown: (() => Promise<void>) | undefined;
  try {
    const boot = await createTaskStoreForBackend({ rootDir: projectPath });
    store = boot.taskStore;
    backendShutdown = boot.shutdown;
    const resolvedStore = store;
    const tasks = await retryOnLock(
      () => resolvedStore.listTasks({ slim: true }),
      { id: projectPath, action: "count tasks" },
    );

    const counts: Record<string, number> = {};
    for (const col of COLUMNS) {
      counts[col] = 0;
    }
    for (const task of tasks) {
      counts[task.column] = (counts[task.column] || 0) + 1;
    }
    return { byColumn: counts, runningAgentCount: countRunningAgentTasks(tasks) };
  } catch {
    // Return empty counts if we can't read the project (not-found, corrupt
    // store, or lock-retry exhaustion — all fail soft here by design).
    return { byColumn: {}, runningAgentCount: 0 };
  } finally {
    try {
      await store?.close();
    } catch {
      // Best-effort: an already-closed/never-initialized store must not throw.
    }
    if (backendShutdown) {
      await backendShutdown().catch(() => undefined);
    }
  }
}

/**
 * Get project health from CentralCore.
 */
async function getProjectHealth(central: CentralCore, projectId: string): Promise<ProjectHealth | undefined> {
  return central.getProjectHealth(projectId);
}

function getLiveInFlightAgentCount(taskCounts: TaskCountSummary): number {
  /*
   * FNXC:CLIProjectHealth 2026-06-26-23:46:
   * FN-7081 confirmed central projectHealth.inFlightAgentCount is slot/health bookkeeping that can be stale or zero in the default in-process runtime.
   * User-visible In-Flight Agents must mirror the dashboard read route and global running-agent count by deriving live agents from the shared top-level slot predicate, including active in-review reviewer/merger/fix agents, without mutating persisted health rows.
   */
  return taskCounts.runningAgentCount;
}

function buildDisplayHealth(
  taskCounts: TaskCountSummary,
  health?: ProjectHealth
): NonNullable<ProjectInfoData["health"]> {
  return {
    activeTaskCount: health?.activeTaskCount ?? 0,
    inFlightAgentCount: getLiveInFlightAgentCount(taskCounts),
    totalTasksCompleted: health?.totalTasksCompleted ?? 0,
    totalTasksFailed: health?.totalTasksFailed ?? 0,
  };
}

/**
 * List all registered projects.
 *
 * @param options - Options including json output flag
 */
export async function runProjectList(options: ProjectListOptions = {}): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const projects = await central.listProjects();
    const defaultProject = await getDefaultProject();

    if (projects.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log("\n  No projects registered.");
        console.log("  Register one with: fn project add <name> <path>\n");
      }
      return;
    }

    // Gather task counts and health for each project
    const projectData: ProjectInfoData[] = await Promise.all(
      projects.map(async (project) => {
        const [taskCounts, health] = await Promise.all([
          getTaskCounts(project.path),
          getProjectHealth(central, project.id),
        ]);

        const displayHealth = buildDisplayHealth(taskCounts, health);

        return {
          id: project.id,
          name: project.name,
          path: project.path,
          status: project.status,
          isolationMode: project.isolationMode,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          lastActivityAt: health?.lastActivityAt ?? project.lastActivityAt,
          health: displayHealth,
          taskCounts: taskCounts.byColumn,
          defaultProject: defaultProject?.id === project.id,
        };
      })
    );

    if (options.json) {
      console.log(JSON.stringify(projectData, null, 2));
      return;
    }

    // Table output
    console.log();
    console.log("  Registered Projects:");
    console.log();

    // Header
    console.log("  Name              Status      Isolation     Tasks  In-Flight  Last Activity");
    console.log("  " + "─".repeat(83));

    for (const project of projectData) {
      const totalTasks = Object.values(project.taskCounts).reduce((a, b) => a + b, 0);
      const statusDot = project.status === "active" ? "●" : project.status === "paused" ? "○" : "○";
      const defaultMarker = project.defaultProject ? " *" : "  ";

      const name = project.name.padEnd(16);
      const status = `${statusDot} ${project.status}`.padEnd(12);
      const isolation = project.isolationMode.padEnd(12);
      const tasks = String(totalTasks).padStart(5);
      const inFlightAgents = String(project.health?.inFlightAgentCount ?? 0).padStart(9);
      const lastActivity = formatLastActivity(project.lastActivityAt);

      console.log(`  ${defaultMarker}${name} ${status} ${isolation} ${tasks}  ${inFlightAgents}  ${lastActivity}`);
    }

    console.log();
    const activeCount = projects.filter((p) => p.status === "active").length;
    console.log(`  ${projects.length} project${projects.length === 1 ? "" : "s"} registered, ${activeCount} active`);
    if (defaultProject) {
      console.log(`  * indicates default project (${defaultProject.name})`);
    }
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Add a new project to the registry.
 *
 * @param name - Project name (optional in interactive mode)
 * @param path - Project path (optional in interactive mode)
 * @param options - Additional options
 */
export async function runProjectAdd(
  name?: string,
  path?: string,
  options: ProjectAddOptions = {}
): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    let projectName = name;
    let projectPath = path;

    // Interactive mode if name or path not provided
    if (!projectName || !projectPath || options.interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      // Get path if not provided
      if (!projectPath) {
        const defaultPath = process.cwd();
        const pathInput = await rl.question(`  Project path [${defaultPath}]: `);
        projectPath = pathInput.trim() || defaultPath;
      }

      // Validate path
      const absolutePath = isAbsolute(projectPath) ? projectPath : resolve(process.cwd(), projectPath);

      if (!existsSync(absolutePath)) {
        console.error(`\n  ✗ Path does not exist: ${projectPath}`);
        rl.close();
        process.exit(1);
      }

      if (!statSync(absolutePath).isDirectory()) {
        console.error(`\n  ✗ Path is not a directory: ${projectPath}`);
        rl.close();
        process.exit(1);
      }

      // Check for .fusion directory
      const fusionDir = resolve(absolutePath, ".fusion");
      const legacyDbPath = resolve(fusionDir, "fusion.db");
      if (!hasProjectIdentity(fusionDir) && !isValidSqliteDatabaseFile(legacyDbPath) && !options.force) {
        console.log(`\n  No fn project found at ${formatDisplayPath(absolutePath)}`);
        const init = await rl.question("  Initialize fn here first? [Y/n] ");
        rl.close();

        if (init.trim().toLowerCase() !== "n") {
          // Initialize the project.
          // FNXC:PostgresCutover 2026-07-05-12:00: boot through the PostgreSQL
          // startup factory; bare `new TaskStore` throws in backend mode. The
          // boot shutdown releases the pool for this one-shot init.
          const boot = await createTaskStoreForBackend({ rootDir: absolutePath });
          const store = boot.taskStore;
          await store.init();
          // FNXC:CliBoardMutation 2026-07-09-00:00: FN-7740 — this init-only
          // store was never closed, leaking a handle for the rest of the
          // process lifetime. Close it right after init; nothing downstream
          // in this handler uses it.
          try {
            await store.close();
          } catch {
            // Best-effort.
          }
          await boot.shutdown().catch(() => {});
          console.log(`  ✓ Initialized fn at ${absolutePath}`);
        } else {
          console.log("\n  Cancelled. Run `fn init` to initialize a project first.\n");
          process.exit(1);
        }
      }

      // Get name if not provided
      if (!projectName) {
        const suggested = basename(absolutePath);
        projectName = await rl.question(`  Project name [${suggested}]: `);
        projectName = projectName.trim() || suggested;
      }

      rl.close();
    }

    // Validate name
    if (!projectName) {
      console.error("\n  ✗ Project name is required\n");
      process.exit(1);
    }

    if (!isValidProjectName(projectName)) {
      console.error(`\n  ✗ Invalid project name '${projectName}'`);
      console.error("  Name must be 1-64 characters and contain only: a-z, A-Z, 0-9, _, -\n");
      process.exit(1);
    }

    // Validate path
    const absolutePath = isAbsolute(projectPath!) ? projectPath! : resolve(process.cwd(), projectPath!);

    if (!existsSync(absolutePath)) {
      console.error(`\n  ✗ Path does not exist: ${projectPath}\n`);
      process.exit(1);
    }

    if (!statSync(absolutePath).isDirectory()) {
      console.error(`\n  ✗ Path is not a directory: ${projectPath}\n`);
      process.exit(1);
    }

    // Check for .fusion directory
    const fusionDir = resolve(absolutePath, ".fusion");
    const legacyDbPath = resolve(fusionDir, "fusion.db");
    if (!hasProjectIdentity(fusionDir) && !isValidSqliteDatabaseFile(legacyDbPath) && !options.force) {
      console.error(`\n  ✗ No fn project found at ${formatDisplayPath(absolutePath)}`);
      console.error("  Run `fn init` first to initialize the project.\n");
      process.exit(1);
    }

    // Validate isolation mode
    const isolationMode = options.isolation ?? "in-process";
    if (!VALID_ISOLATION_MODES.includes(isolationMode)) {
      console.error(`\n  ✗ Invalid isolation mode '${isolationMode}'`);
      console.error(`  Valid options: ${VALID_ISOLATION_MODES.join(", ")}\n`);
      process.exit(1);
    }

    // Check for duplicate name
    const existing = await findProjectByName(central, projectName);
    if (existing) {
      console.error(`\n  ✗ Project '${projectName}' already registered.\n`);
      process.exit(1);
    }

    const identity = readProjectIdentity(fusionDir);
    const ensured = await central.ensureProjectForPath({
      path: absolutePath,
      identity: identity ?? undefined,
      name: projectName,
    });

    const project = ensured.project;

    // Activate the project (registration sets it to 'initializing')
    await central.updateProject(project.id, { status: "active" });

    try {
      writeProjectIdentity(join(absolutePath, ".fusion"), {
        id: project.id,
        createdAt: project.createdAt,
      });
    } catch (identityError) {
      console.warn(`  ⚠ Warning: Could not persist project identity: ${identityError instanceof Error ? identityError.message : String(identityError)}`);
    }

    // Bootstrap memory files (non-fatal if it fails)
    let memoryInitialized = false;
    try {
      memoryInitialized = await ensureMemoryFileWithBackend(absolutePath);
    } catch (err) {
      console.warn(`  ⚠ Warning: Could not initialize project memory: ${err instanceof Error ? err.message : String(err)}`);
    }

    maybeInstallClaudeSkillForNewProject(absolutePath);

    console.log();
    console.log(`  ✓ Registered project '${projectName}'`);
    console.log(`    Location: ${formatDisplayPath(project.path)}`);
    console.log(`    ID: ${project.id}`);
    console.log(`    Isolation: ${project.isolationMode}`);
    if (ensured.gitRepository === "initialized") {
      console.log(`    Git: initialized`);
    }
    if (memoryInitialized) {
      console.log(`    Memory: initialized`);
    }
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Remove a project from the registry.
 *
 * @param name - Project name
 * @param options - Options including force flag
 */
export async function runProjectRemove(name: string, options: ProjectRemoveOptions = {}): Promise<void> {
  if (!name) {
    console.error("Usage: fn project remove <name> [--force]");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const project = await findProjectByNameOrId(central, name);
    if (!project) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }

    if (!options.force) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Unregister project '${project.name}'? [y/N] `);
      rl.close();

      if (answer.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    await central.unregisterProject(project.id);
    console.log();
    console.log(`  ✓ Unregistered project '${project.name}'`);
    console.log(`    Location: ${formatDisplayPath(project.path)}`);
    console.log();
    console.log("  Note: Project data is preserved. You can re-register with:");
    console.log(`        fn project add ${project.name} ${project.path}`);
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Show detailed information about a project.
 *
 * @param name - Project name (optional, uses detection if not provided)
 */
export async function runProjectShow(name?: string): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    let project: RegisteredProject | undefined;

    if (name) {
      project = await findProjectByNameOrId(central, name);
    } else {
      // Auto-detect from cwd
      const detected = await detectProjectFromCwd(process.cwd(), central);
      if (detected) {
        // detected might be a full project or just path info
        if ("id" in detected && detected.id) {
          project = await central.getProject(detected.id);
        }
        if (!project) {
          // Unregistered project with .fusion
          console.log();
          console.log(`  Project: ${detected.name}`);
          console.log(`  Location: ${formatDisplayPath(detected.path)}`);
          console.log(`  Status: (not registered)`);
          console.log();
          const counts = await getTaskCounts(detected.path);
          const total = Object.values(counts.byColumn).reduce((a, b) => a + b, 0);
          if (total > 0) {
            console.log(`  Tasks: ${total} total`);
            for (const [col, count] of Object.entries(counts.byColumn)) {
              if (count > 0) {
                console.log(`    ${COLUMN_LABELS[col as Column]}: ${count}`);
              }
            }
          }
          console.log();
          console.log("  Run 'fn project add' to register this project.");
          console.log();
          return;
        }
      }
    }

    if (!project) {
      console.error(`Error: Project '${name || "current directory"}' not found.`);
      process.exit(1);
    }

    const defaultProject = await getDefaultProject();
    const isDefault = defaultProject?.id === project.id;
    const [health, taskCounts] = await Promise.all([
      getProjectHealth(central, project.id),
      getTaskCounts(project.path),
    ]);

    console.log();
    console.log(`  Project: ${project.name}${isDefault ? " (default)" : ""}`);
    console.log(`  ID: ${project.id}`);
    console.log(`  Location: ${formatDisplayPath(project.path)}`);
    console.log(`  Status: ${project.status}`);
    console.log(`  Isolation: ${project.isolationMode}`);
    console.log(`  Created: ${project.createdAt ?? "unknown"}`);
    console.log(`  Updated: ${project.updatedAt ?? "unknown"}`);

    const displayHealth = buildDisplayHealth(taskCounts, health);
    const lastHealthActivityAt = health?.lastActivityAt ?? project.lastActivityAt;

    console.log();
    console.log(`  Health:`);
    console.log(`    Active Tasks: ${displayHealth.activeTaskCount}`);
    console.log(`    In-Flight Agents: ${displayHealth.inFlightAgentCount}`);
    console.log(`    Completed: ${displayHealth.totalTasksCompleted}`);
    console.log(`    Failed: ${displayHealth.totalTasksFailed}`);
    if (lastHealthActivityAt) {
      console.log(`    Last Activity: ${formatLastActivity(lastHealthActivityAt)}`);
    }

    console.log();
    console.log(`  Tasks:`);
    const total = Object.values(taskCounts.byColumn).reduce((a, b) => a + b, 0);
    console.log(`    Total: ${total}`);
    for (const col of COLUMNS) {
      const count = taskCounts.byColumn[col] || 0;
      if (count > 0) {
        console.log(`    ${COLUMN_LABELS[col]}: ${count}`);
      }
    }

    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Alias for runProjectShow - shows project details.
 */
export const runProjectInfo = runProjectShow;

/**
 * Set the default project.
 *
 * @param name - Project name
 */
export async function runProjectSetDefault(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: fn project set-default <name>");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const project = await findProjectByNameOrId(central, name);
    if (!project) {
      console.error(`Error: Project '${name}' not found.`);
      process.exit(1);
    }

    await setDefaultProject(project.id);
    console.log();
    console.log(`  ✓ Set '${project.name}' as default project`);
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Detect project from current directory.
 */
export async function runProjectDetect(): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const project = await detectProjectFromCwd(process.cwd(), central);

    if (project) {
      console.log();
      console.log(`  Detected: ${project.name}`);
      console.log(`  Location: ${formatDisplayPath(project.path)}`);
      if ("id" in project && project.id) {
        console.log(`  ID: ${project.id}`);
        const health = await getProjectHealth(central, project.id);
        if (health) {
          console.log(`  Status: ${health.status}`);
        }
      } else {
        console.log(`  Status: (not registered)`);
      }
      console.log();
    } else {
      console.log();
      console.log("  No fn project detected from current directory.");
      console.log();
    }
  } finally {
    await central.close();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function getDefaultProject(): Promise<RegisteredProject | undefined> {
  const globalStore = new GlobalSettingsStore();
  await globalStore.init();

  const settings = await globalStore.getSettings();
  if (!settings.defaultProjectId) {
    return undefined;
  }

  const central = new CentralCore();
  await central.init();
  try {
    return await central.getProject(settings.defaultProjectId);
  } finally {
    await central.close();
  }
}

async function findProjectByName(central: CentralCore, name: string): Promise<RegisteredProject | undefined> {
  const allProjects = await central.listProjects();
  const lowerName = name.toLowerCase();
  return allProjects.find((p) => p.name.toLowerCase() === lowerName);
}

async function findProjectByNameOrId(central: CentralCore, nameOrId: string): Promise<RegisteredProject | undefined> {
  const byId = await central.getProject(nameOrId);
  if (byId) {
    return byId;
  }
  return findProjectByName(central, nameOrId);
}

function isValidProjectName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(name);
}
